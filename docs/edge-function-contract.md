# Edge Function security contract

Mandatory rules for every Supabase Edge Function in this project. They are
implementation requirements: a function that breaks one of them must not be
deployed. The database already enforces what it can (see `docs/security.md`).
These rules cover what only server code can do.

"MUST" means required. "SHOULD" means required unless a reviewed exception is
written down in the function's README.

---

## 1. Two kinds of database client

| Client | Created with | Use it for |
|---|---|---|
| **User client** | Publishable/anon key + the caller's `Authorization: Bearer <user JWT>` header | **Every tenant-scoped read or write made on behalf of a user**, and `begin_privileged_action` (§4). RLS and the SQL RPCs authorize the request, and the audit trail records the real actor (`auth.uid()`). |
| **Service client** | `service_role` / secret key | Only work a user cannot do directly: the Vault token RPCs, `create_oauth_connection`, `start_sync_job`, scheduled syncs, `expire_stale_invitations()`. |

- MUST NOT use the service client for a change that a user client plus an RPC
  can perform.
- MUST NOT accept a user id, tenant role, or "acting as" value from the
  request body, query string or custom headers, and MUST NOT write one into
  the database. The actor is whoever the verified JWT says it is (§4).
- The service key is the project's master secret (see "Service-role key and
  Vault boundary" in `docs/security.md`). MUST NOT log, return or forward it.

## 2. Authentication of every request

- MUST keep `verify_jwt = true` (the default) for every function a browser
  calls. Only provider webhooks or OAuth callbacks may opt out, and each such
  function MUST authenticate the caller another way (signature or `state`, see
  §6).
- MUST resolve the user with `supabase.auth.getUser(jwt)` (a server-side check)
  before doing any work. Never trust a decoded but unverified JWT.
- Platform-admin actions MUST go through the user client, so the database's
  `aal2` check applies. A function MUST NOT grant admin behaviour from
  `platform_admins` membership alone.
- MUST reject the request if `getUser` fails, the user is banned, or the e-mail
  is unconfirmed where the operation needs it.

## 3. Tenant checks

- Tenant-scoped functions MUST take the tenant id from the request and let
  the database decide access (RLS or RPC).
- For service-client work, the database decides through
  `begin_privileged_action` (§4). Functions MUST NOT replace that with their
  own role checks.
- MUST return the same generic error for "does not exist" and "not allowed".

## 4. Recording the initiating user for service-role work

With the service key, `auth.uid()` is NULL. A function therefore cannot simply
"tell" the database who the user is: an id in a request is just a claim. The
database instead issues a short-lived **privileged action** to the
authenticated user and attributes the service-role work to whoever created it.

```
Browser ──JWT──> Edge Function
                   1. user client:    rpc('begin_privileged_action',
                                          { p_tenant_id, p_action, p_target_id })
                      -> DB checks role (manager+ or aal2 platform admin),
                         tenant status and target ownership, and records
                         auth.uid() as actor. Returns { action_id, action_expires_at }.
                   2. service client: rpc('<service RPC>', { p_action_id: action_id, ... })
                      -> DB re-checks the action (type, tenant, target, expiry,
                         initiator still authorized) and binds it to the transaction.
                   3. audit_logs rows from that call:
                         user_id = initiating user, actor_role = 'service_role',
                         details.privileged_action_id = action_id
```

| Workflow | `p_action` | `p_target_id` | Service RPC that consumes it |
|---|---|---|---|
| OAuth start | `oauth.connect` | — | `create_oauth_connection(p_action_id, p_tenant_id, p_provider)` |
| OAuth callback | `oauth.connect` (same id) | — | `store_oauth_tokens(..., p_action_id)` |
| Disconnect | `oauth.disconnect` | connection id | `delete_oauth_tokens(p_connection_id, p_action_id)` |
| Manual sync | `sync.start` | connection id | `start_sync_job(p_action_id, p_connection_id, p_job_type)` |
| Report generation | `report.generate` | report id or none | future RPC, same pattern |

Rules:
- MUST create the action with the **user client** in the same request that
  the user made. Never create one on a user's behalf with the service client
  (there is no grant for that).
- MUST pass `action_id` only between your own server-side steps (for example
  inside the OAuth `state` record, §6). It is not a secret credential, but it
  MUST NOT be accepted from the browser as a substitute for step 1.
- Actions expire after 15 minutes, can be reused within that window for the
  same tenant, purpose and target, and stop working as soon as the initiator
  loses the manager+ role or platform-admin status.
- The binding lasts for one database transaction (one PostgREST call) and only
  applies to rows of the action's tenant.
- Work no user started (scheduled syncs, token refresh, expiry jobs) passes no
  action id and is recorded as `actor_role = 'service_role'` with
  `user_id = NULL`. That is correct and expected.
- Any **new** service-role RPC that acts for a user MUST take `p_action_id`
  and call `private.use_privileged_action(...)` before writing. Add its action
  type to the CHECK on `private.privileged_actions.action` and add tests.

## 5. Invitations and members

| Operation | How |
|---|---|
| Invite | User client → `rpc('create_invitation', { p_tenant_id, p_email, p_role })`. The database checks the caller's role (owner: any role; admin: manager/viewer/client), the tenant status and a 30-per-hour limit per inviter, and generates a 256-bit token. |
| Resend | Call `create_invitation` again. The old pending invitation is revoked, so its token stops working. |
| Revoke | User client → `rpc('revoke_invitation', { p_invitation_id })` |
| Change role | User client → `rpc('change_member_role', …)` |
| Remove member | User client → `rpc('deactivate_member', …)`. This also revokes their pending invitations. |
| Accept | Browser → `rpc('accept_invitation', { p_token })` (signed in, confirmed e-mail that matches the invitation) |
| Expire | Daily scheduled job, service client → `rpc('expire_stale_invitations')` |

Every tenant always keeps at least one active owner. A database trigger
enforces this for every role, including platform admins and `service_role`.
Expect error `23514` and show a clear message.

The invite function MUST:
- send the returned `invitation_token` only inside the e-mail, as a link to
  the frontend accept page, e.g. `https://<site>/accept-invite#token=<token>`.
  Prefer the URL fragment: it is not sent to servers or included in `Referer`.
- respond to the browser with `invitation_id` and `invitation_expires_at` only,
  **never the token**;
- never log the token, the full link or the e-mail body;
- apply its own per-IP rate limit (§9), on top of the database limit.

The accept page MUST read the token from the fragment, POST it to
`accept_invitation`, then remove it from the address bar with
`history.replaceState`.

## 6. OAuth connect (Meta, Google)

Start (signed-in user, manager or higher, active tenant):
1. User client → `begin_privileged_action(tenant_id, 'oauth.connect')`. If it
   fails, stop.
2. Service client → `create_oauth_connection(action_id, tenant_id, provider)`
   returns the pending `connection_id`.
3. Generate `state` as at least 32 random bytes (`crypto.getRandomValues`),
   plus a PKCE `code_verifier` (43–128 chars) and its S256 `code_challenge`.
4. Store `{state hash, code_verifier, user_id, tenant_id, connection_id,
   action_id, provider, expires_at = now + 10 min}` server-side. Use a private
   table or an encrypted, `HttpOnly`, `Secure`, `SameSite=Lax` cookie. Never
   put the verifier in the URL.
5. Redirect to the provider with `state`, `code_challenge`,
   `code_challenge_method=S256`, the **exact** pre-registered `redirect_uri`
   and the minimum scopes.

Callback:
1. MUST look up `state` and reject it if missing, expired or already used. It
   is single-use, so delete it on first sight.
2. MUST check that the signed-in user (from the JWT or the bound cookie) is the
   one who started the flow.
3. Exchange the code with the stored `code_verifier`, server-to-server only.
4. Verify the returned account and scopes, then call (service client)
   `store_oauth_tokens(connection_id, access_token, refresh_token, expires_at, action_id)`.
   The database re-checks that the initiator is still manager+.
5. Redirect the browser to a fixed frontend URL. Never echo provider errors,
   codes or tokens into the URL.

## 7. Token lifecycle

- Tokens live only in Vault. Only Edge Functions read them, with
  `get_oauth_tokens` (service client). Hold them in memory for the one request
  and **never return them to a browser**, log them, or store them anywhere else.
- Before every provider call or refresh, MUST check that the connection's tenant
  is `active`. `store_oauth_tokens` refuses inactive tenants, but
  `get_oauth_tokens` deliberately does not, so that disconnect can still revoke
  at the provider.
- Refresh (background, no user): call the provider, then
  `store_oauth_tokens(connection_id, new_access_token, new_refresh_or_NULL, expires_at)`
  without an action id. Pass `NULL` as the refresh token if the provider
  returned none. An empty string is rejected.
- If the provider reports the grant revoked or invalid, set the connection
  `status = 'expired'` or `'error'` and stop retrying.
- Disconnect, by a manager+ user or an aal2 platform admin:
  1. User client → `begin_privileged_action(tenant_id, 'oauth.disconnect', connection_id)`
  2. Service client → `get_oauth_tokens(connection_id)`
  3. Revoke at the provider (Google: `https://oauth2.googleapis.com/revoke`;
     Meta: `DELETE /{user-id}/permissions`)
  4. Service client → `delete_oauth_tokens(connection_id, action_id)`, which
     purges Vault and marks the connection revoked.

  If revocation at the provider fails, still delete locally and record the
  failure in `sync_logs`.
- Manual sync: user client → `begin_privileged_action(tenant_id, 'sync.start', connection_id)`,
  then service client → `start_sync_job(action_id, connection_id)`. The
  database allows one queued or running job per connection.
- MUST NOT copy tokens into `sync_logs`, `sync_jobs.error_message`,
  `daily_metrics.source_payload` or exception messages. Redact `access_token`,
  `refresh_token`, `code` and `client_secret` from anything logged.

## 8. Report downloads

- The browser asks a function for a download. The function uses the **user
  client** to read the `reports` row: RLS proves access, and suspended,
  inactive and other-tenant users get nothing. It then issues a signed URL with
  `createSignedUrl(storage_path, 60)` (60 seconds or less).
- MUST use the `storage_path` from the database row, never a path from the request.
- Uploads are made only by trusted generators (service client or aal2 platform
  admin) to `<tenant_id>/<report_id>.<ext>`. Set `contentType` explicitly to
  PDF, CSV or XLSX. User-requested generation uses a `report.generate` action (§4).

## 9. Rate limiting and abuse

| Endpoint | Minimum limit |
|---|---|
| Invite / resend | 10 per user per minute and 30 per user per hour (the DB enforces 30/hour); 100 per IP per hour |
| Accept invitation | 10 attempts per user per 10 minutes. Tokens are 256-bit, so this limits noise, not guessing. |
| Privileged actions (all types) | The DB enforces 60 per user per hour. Functions SHOULD add tighter per-endpoint limits below. |
| OAuth start | 10 per user per 10 minutes |
| Report download URL | 60 per user per minute |
| Manual sync trigger | 1 queued/running job per connection (DB-enforced); 6 per tenant per hour |

Store counters server-side (a private table or the platform's KV). Return
HTTP 429 with no detail when a limit is hit.

## 10. Errors, logging and CORS

- Return generic messages to the browser. Detailed causes go to `sync_logs`
  (platform-admin readable) or the function logs, with secrets redacted.
- Set `Access-Control-Allow-Origin` to the exact production origin (and
  `http://localhost:5173` in development only). Never `*` on authenticated
  functions.
- Validate every input (UUID format, e-mail, enum values, lengths) before using it.

## 11. Review checklist for every new function

- [ ] User client used for all user-initiated tenant changes
- [ ] `getUser()` called; no identity or role taken from the body
- [ ] Service-role work for a user uses `begin_privileged_action` → `p_action_id`
- [ ] No service key, OAuth token, `state`, verifier or invite token in logs, errors or responses
- [ ] Rate limit applied
- [ ] CORS restricted
- [ ] pgTAP or integration test added for any new RPC; `07_catalog.test.sql` allowlist updated deliberately
