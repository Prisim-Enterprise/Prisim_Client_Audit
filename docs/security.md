# Security

## Principles

1. **The database enforces isolation.** Every table has Row Level Security.
   The frontend is untrusted; hiding a button is never a security control.
2. **Deny by default.** API roles start with no privileges (migration 0002
   revokes Supabase's implicit grants) and receive only explicit grants.
3. **Secrets stay server-side.** The browser only ever holds the publishable
   key and the user's own JWT.
4. **Least privilege for tenant users.** Read-only tables. Changes go through
   SQL RPCs that check roles themselves and run with the caller's own JWT, so
   the actor is always known.
5. **Everything security-relevant is audited** in an append-only log.
6. **Staff power needs MFA.** Platform-admin privileges exist only in an
   `aal2` (TOTP-verified) session, checked in the database.

Related documents:
[deployment-checklist.md](deployment-checklist.md) (hosted settings and
pre-flight) and [edge-function-contract.md](edge-function-contract.md)
(mandatory rules for server code).

## Threat model (summary)

| Threat | Control |
|---|---|
| Client reads another client's data | RLS on every table via `private.my_tenant_ids()`; composite FKs stop rows being attached to the wrong tenant; pgTAP tests for every role |
| Client escalates own role | No write grants on memberships for tenant users. Role changes only via `change_member_role` / `deactivate_member` (owners: anything; admins: below admin only) or aal2 platform admins. Roles are never read from `user_metadata`. |
| Tenant left without an owner | Trigger `protect_last_owner` blocks deactivating, downgrading, removing or moving the last active owner for **every** role and path (RPCs, platform-admin table writes, `service_role`, SQL), with a per-tenant lock against races. Only deleting the tenant itself or the owner's auth account may cascade it away. |
| Self-service platform-admin grant | `platform_admins` has no INSERT/UPDATE/DELETE grant for API roles; SQL only |
| Stolen staff password | `private.is_platform_admin()` requires JWT `aal = 'aal2'`. An aal1 session of a listed admin has no admin privileges (DB, Storage and RPCs). |
| Suspended client keeps access | All helpers require `tenants.status = 'active'` and an `active` membership |
| OAuth token theft | Tokens encrypted in Supabase Vault; mapping table in the non-exposed `private` schema; token RPCs executable by `service_role` only; legacy public token columns locked to NULL; secrets purged on delete or re-point |
| Invitation token theft or guessing | 256-bit tokens generated in the database. Only the SHA-256 hash is stored, and that column is not selectable. The invite is bound to a confirmed e-mail, single use, 7-day expiry, one generic error. Status can only go pending → accepted/revoked/expired. Resend and deactivation revoke older tokens. |
| Internal error leakage | `sync_jobs` / `sync_logs` visible to platform admins only; clients use `get_tenant_sync_status()`; `daily_metrics.source_payload` is not selectable through the API |
| Report file leakage | Private bucket, forced private by the migration even if it already existed. The read policy checks that the first path segment is a tenant the caller can access. A DB constraint keeps `reports.storage_path` inside the tenant folder. |
| Audit tampering or forgery | `audit_logs` is written only by the audit trigger. No role, including `service_role`, has INSERT/UPDATE/DELETE/TRUNCATE. Triggers reject UPDATE/DELETE/TRUNCATE even for the table owner. No foreign keys, so deleting users or tenants never rewrites audit rows. The actor comes from the JWT (`user_id`, `actor_role`). |
| Unattributed or spoofed service-role work | Service-role workflows for a user require a **privileged action** that the user created with their own JWT (`begin_privileged_action`: role-checked, tenant- and target-bound, 15-minute expiry, revalidated on use). The audit trigger takes `user_id` from that action, never from a request. `service_role` can neither read nor create actions, and cannot set the binding through the API. |
| `SECURITY DEFINER` hijack via `search_path` | All application functions use `SET search_path = ''` and schema-qualified names (asserted by `07_catalog.test.sql`) |
| New function accidentally exposed | `07_catalog.test.sql` holds exact allowlists of functions executable by `authenticated` and `service_role` |
| Open sign-up | Sign-ups disabled; accounts are created only by invitation |

## Keys and secrets

| Secret | Where it lives | Never |
|---|---|---|
| Publishable / anon key | `frontend/.env.local`, Cloudflare Pages env vars | n/a, it is public |
| `service_role` / `sb_secret_...` key | Supabase Edge Functions only (injected automatically). See "Service-role key and Vault boundary" below. | In the frontend, in `VITE_*` variables, in git, in Cloudflare, in API responses or logs |
| Database password | Password manager of the project owner | In git, `.env` files, chat or tickets |
| Meta app secret, Google client secret, Google Ads developer token | `npx supabase secrets set NAME=value` | In the frontend or git |
| OAuth access/refresh tokens | Supabase Vault via `store_oauth_tokens` | In `public` tables, logs or API responses |

Git protections: `.gitignore` excludes `.env*` (except `.env.example`),
`supabase/.temp/` and `.env.keys`. Before committing, check `git diff --cached`
for anything that looks like a key.

If a secret leaks: rotate it immediately (Dashboard → Project Settings → API
keys / Database password; regenerate provider app secrets), redeploy Edge
Functions, then review `audit_logs` and Auth logs.

## Service-role key and Vault boundary

The `service_role` / `sb_secret_...` key is the project's **master secret**.
Anyone holding it bypasses Row Level Security, can call every
service-role-only RPC (including `get_oauth_tokens`), and, through Supabase's
default grants, can read `vault.decrypted_secrets` directly. The database
cannot protect OAuth tokens from a holder of this key. Keeping the key inside
the boundary below is what protects them.

**Boundary: the key and decrypted OAuth tokens exist only inside Supabase Edge
Functions.**

| Rule | How it is enforced |
|---|---|
| The key never enters frontend environment variables | Only `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_APP_URL` and `VITE_APP_ENV` exist (`frontend/.env.example`). Every `VITE_*` value is bundled into public JavaScript. `npm run check:secrets` (part of `npm run db:test`) fails on any `sb_secret_` key, any `service_role` JWT anywhere in the working tree (including `frontend/.env*` and a built `frontend/dist`), and any `VITE_*` name containing SERVICE / SECRET / PRIVATE / PASSWORD. Run it on CI and before each Cloudflare deploy. |
| The key is never returned through an API | The key is injected into Edge Functions by Supabase (`SUPABASE_SERVICE_ROLE_KEY` / secret key env). No table, view or RPC stores or returns it. Edge Functions MUST NOT echo environment variables, include them in errors, or log request headers ([edge-function-contract.md](edge-function-contract.md) §1). |
| OAuth tokens are never returned to browser clients | `get_oauth_tokens`, `store_oauth_tokens` and `delete_oauth_tokens` are executable only by `service_role` (the `07_catalog.test.sql` allowlist). Legacy token columns are NULL by constraint and not selectable. `private.oauth_credentials` and `vault` are not exposed through the Data API. Tested with real JWTs: a signed-in user, and even an aal2 platform admin, get an error from `get_oauth_tokens` (`scripts/auth-api.test.mjs`). Edge Functions MUST NOT put tokens in responses (contract §7). |
| Only Edge Functions retrieve decrypted OAuth tokens | Edge Functions are the only application component that holds the service key. The frontend (Cloudflare Pages) holds only the publishable key. No other backend exists. A new component that needs tokens requires a security review and an update to this section. |

Accepted residual risk: a leaked service key exposes every tenant's tokens.
Mitigations: rotate immediately (see above), then revoke and reconnect the
affected provider grants. Keep the number of people with Dashboard access,
which can reveal the key, to a minimum.

## Authentication settings

`supabase/config.toml` configures **only the local stack**. The required
hosted Auth, Storage and API settings, a read-only data pre-flight, and the
pre- and post-push checks are in
[deployment-checklist.md](deployment-checklist.md). MFA (TOTP) must be
enabled on the hosted project: platform-admin privileges require it, and the
database enforces this.

## Frontend notes

- Select explicit columns on `daily_metrics` and `oauth_connections`. Column
  grants hide `source_payload` and the legacy token columns, so `select('*')`
  is rejected.
- After a platform admin signs in, if `get_my_context()` returns
  `platform_admin_mfa_required: true`, prompt for the TOTP code
  (`supabase.auth.mfa.challengeAndVerify`) before showing admin screens.

## Bootstrapping the first platform administrator

After migration 0002 is applied, a project owner runs this once in the
Dashboard SQL editor (replace the e-mail):

```sql
INSERT INTO public.platform_admins (user_id, note)
SELECT id, 'Initial PRISIM administrator'
FROM auth.users
WHERE email = 'admin@your-domain.example';
```

Remove an administrator with
`DELETE FROM public.platform_admins WHERE user_id = '<uuid>';`. Both actions
are recorded in `audit_logs`. The new admin has no admin privileges until they
have enrolled TOTP and signed in with it.

## Applying migrations to production

Only a maintainer applies migrations, and only after review and approval.

```bash
# 1. Validate locally (requires Docker Desktop)
npm run db:start
npm run db:reset          # applies all migrations + seed to the LOCAL database
npm run db:test           # all pgTAP tests + the Auth API integration test must pass
npm run db:lint

# Supabase CLI v3 targets the LOCAL database unless --remote is passed.
# Every command below that touches the hosted project says --remote explicitly.

# 2. Inspect the hosted project (read-only)
npx supabase migration list --remote     # remote should list only 202611050001 as applied
npx supabase db push --remote --dry-run  # must list only the new migration(s)

# 3. Back up the hosted schema and data (free plan has no managed backups)
npx supabase db dump --remote -f backups/schema.sql
npx supabase db dump --remote --data-only -f backups/data.sql
#    keep backups/ out of git; it contains client data

# 4. Apply
npx supabase db push --remote

# 5. Verify
npx supabase migration list --remote
npx supabase db lint --remote
#    Dashboard -> Advisors -> Security and Performance: resolve new warnings
```

Never use `--include-seed` with `db push`, never run `supabase db reset --remote`
(it wipes the hosted database), and never paste `seed.sql` into the hosted SQL
editor.

## Pre-go-live checklist

- [ ] Migration 0002 applied; all pgTAP tests pass locally
- [ ] Dashboard Auth settings match the table above
- [ ] First platform admin bootstrapped; MFA enrolled
- [ ] Security Advisor shows no errors
- [ ] Edge Function secrets set; none present in the frontend bundle
      (search the built `dist/` for `service_role` and `sb_secret_`)
- [ ] Production SMTP configured
- [ ] Cloudflare Pages env vars contain only `VITE_*` public values
