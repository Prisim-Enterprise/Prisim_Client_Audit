# Milestone 2 — Backend Contracts and Tenant Management

## Status and scope

This document defines the proposed backend contract for the PRISIM Admin
Dashboard and tenant management. The invitation security design below was
superseded during local remediation; see
[`migration-0002-security-remediation.md`](migration-0002-security-remediation.md)
for the current source contract and exact implementation status. No hosted
database operation was performed.

The migration files are the schema source of truth. `docs/database-schema.md`
records migration 0001 as applied and migration 0002 as not yet applied; those
are repository records, not independent evidence of the current hosted
database state. This design describes the target contract after the required
security migration has been reviewed and explicitly deployed.

## 1. Architecture overview

- React/Vite is an untrusted presentation client. It uses only the Supabase
  publishable/anon key and the signed-in user's access token.
- PostgreSQL is the authorization and transaction boundary. RLS protects
  tenant data; privileged operations use narrowly scoped RPCs that verify
  `auth.uid()`, tenant role, tenant status, and (for platform administrators)
  `aal = 'aal2'`.
- Use an RPC for an operation that needs a single database transaction,
  database-enforced authorization, or a result assembled from protected
  tables.
- Use an Edge Function to orchestrate work outside a database transaction,
  such as sending an invitation email. Browser-callable functions verify the
  caller with `auth.getUser()`, forward the caller JWT for user authorization,
  and keep the service-role key server-side.
- Never use a frontend route guard, caller-supplied user ID, metadata role, or
  browser storage as authorization.
- Do not use a service-role client for routine user-authorized database work.
  The invitation token-delivery path is a narrowly scoped exception: its raw
  token must remain inside the Edge Function and must not be returned by a
  browser-callable RPC.

### Existing schema relevant to this milestone

Migration 0001 defines `tenants`, `profiles`, `tenant_memberships`,
`oauth_connections`, `reports`, and `audit_logs`, along with the advertising,
sync, and metrics tables. Tenant status is constrained to `active`, `inactive`,
or `suspended`; membership roles are `owner`, `admin`, `manager`, `viewer`,
and `client`. It has a unique tenant slug and unique `(tenant_id, user_id)`
membership. Its member-read policies for `sync_jobs` and `sync_logs` are
broader than the hardened target.

Migration 0002 adds or changes:

- `platform_admins`, managed through SQL by the project owner; API roles have
  no write path.
- `tenant_invitations`, with a SHA-256 token hash, one pending invitation per
  tenant/email, a seven-day expiry, and one-way pending-to-terminal status
  transitions.
- `private.oauth_credentials`, whose Vault references are not exposed through
  the Data API. Legacy OAuth token columns remain unavailable to clients.
- `private.privileged_actions` for short-lived, transaction-bound attribution
  of certain service-role workflows.
- `private.is_platform_admin()`, which requires both a listed platform admin
  and JWT AAL2; `private.my_tenant_ids()` and related helpers, which require an
  active membership in an active tenant.
- `get_my_context()`, `accept_invitation(text)`,
  `create_invitation(action_id,tenant_id,email,role,token_hash)`,
  `fail_invitation_delivery(action_id,invitation_id)`,
  `revoke_invitation(uuid)`, `change_member_role(uuid,uuid,text)`,
  `deactivate_member(uuid,uuid)`, and `expire_stale_invitations()`.
- Tenant/member/invitation integrity, `protect_last_owner`, append-only audit
  triggers, explicit API grants, tightened RLS, and private report storage
  policies.

`profiles.email` and user profile creation/synchronization are added by 0002.
`audit_logs` in 0001 has actor, action, entity, details, and timestamp fields;
0002 adds `actor_role`, removes foreign keys that could rewrite historical
audit entries, and records changes through database triggers.

Important current-contract gaps:

1. There is no tenant-plus-initial-owner RPC. Migration 0002 currently grants
   platform admins tenant and membership table writes, so separate direct
   writes could leave partial application state.
2. The original invitation RPC returned the raw token to its authenticated
   caller. Local unapplied source now removes that return path and routes
   creation through a service-only hash-storage RPC and protected Edge Function.
3. There is no platform-admin creation/removal RPC, by design. Local
   unapplied source adds a trigger that prevents deleting/reassigning the final
   platform-admin row; staff assignment remains owner-controlled SQL.
4. The current audit trigger captures row snapshots (with selected secret
   fields removed); invitation email and other personal fields are not all
   redacted. `actor_role` is the JWT/database execution role, not necessarily
   the application role such as `owner` or `platform_admin`.
5. There is no subscription/billing model or tenant-management Edge Function.

## 2. Tenant creation

### Contract: `admin_create_tenant`

**Entry point:** new authenticated PostgreSQL RPC. The frontend calls it using
the user's Supabase session. Do not implement tenant creation as a sequence of
independent frontend inserts or as an Edge Function using service-role
credentials.

**Request**

```ts
type CreateTenantRequest = {
  businessName: string;
  slug: string;
  ownerEmail: string;
  status: "active" | "inactive" | "suspended";
  requestId: string; // UUID idempotency key
};
```

Equivalent SQL signature:
`public.admin_create_tenant(p_business_name text, p_slug text, p_owner_email text, p_status text, p_request_id uuid)`.

**Response**

```ts
type CreateTenantResponse = {
  tenantId: string;
  slug: string;
  status: "active" | "inactive" | "suspended";
  owner: { userId: string; email: string };
};
```

Return the minimum information needed to update the UI. Do not return an Auth
user record, access token, or service credential.

**Authorization:** authenticated user; `private.is_platform_admin()` must
return true, which requires a listed platform administrator and AAL2. Reject
an AAL1 session even if that user is listed.

**Atomicity and owner onboarding:** one RPC invocation is one PostgreSQL
transaction. It must validate and normalize inputs, resolve exactly one
existing `auth.users` account by normalized email, require its email to be
confirmed, insert the tenant, and insert its `owner` membership. Any failure
rolls back both inserts and the idempotency record. Membership status is
`active`; tenant status is the requested valid status. An inactive or suspended
tenant remains inaccessible to client users until activated.

Supabase Auth Admin API operations cannot participate in this database
transaction. Therefore, for this contract, the owner account must already
exist and have a confirmed email before tenant creation. Provisioning a new
Auth user is a separate, owner-approved onboarding step. If the business
requires creating tenants for people who do not yet have Auth accounts, the
owner must approve a different staged-onboarding workflow; it cannot truthfully
promise tenant and owner membership are created atomically.

**Database effects:** `tenants`, `tenant_memberships`, and a private
idempotency record. Existing audit triggers record the tenant and owner
membership within the same transaction. The new idempotency store records the
actor, operation, request hash, and result ID, but not owner email or other
unnecessary PII.

**RLS and grants:** `SECURITY DEFINER`, empty `search_path`, fully qualified
objects, explicit input validation, and an explicit `private.is_platform_admin()`
check. A new migration should revoke direct authenticated `INSERT`/`UPDATE`
on `tenants` and direct membership write paths that bypass their RPC
invariants, while preserving intended reads and other approved writes.
Revoke function execution from `PUBLIC` and `anon`; grant only to
`authenticated`. RLS remains enabled and must not be weakened.

**Idempotency:** same actor + operation + `requestId` + same request hash
returns the original result. Reusing the key with a different payload, or by
another actor, returns `409 IDEMPOTENCY_CONFLICT`. The request key, tenant,
membership, and audit records commit or roll back together. The unique slug
constraint remains the final collision guard.

**Errors:** `42501 ADMIN_MFA_REQUIRED_OR_FORBIDDEN`; `22023 INVALID_INPUT` or
`OWNER_ACCOUNT_NOT_READY`; `23505 SLUG_ALREADY_EXISTS`; `23514` for a violated
invariant; idempotency mismatch maps to `409 IDEMPOTENCY_CONFLICT`. Do not
reveal whether an arbitrary email belongs to an Auth account to a non-admin.

## 3. Tenant listing and details

### Contract: `admin_list_tenants`

**Entry point:** new authenticated RPC. A single RPC is preferred over
multiple browser queries because owner, count, and latest activity are joins
across protected records and need a stable bounded response.

**Request**

```ts
type TenantListRequest = {
  status?: "active" | "inactive" | "suspended";
  search?: string; // business name or slug; bounded length
  sort?: "created_at_desc" | "created_at_asc" | "name_asc" | "name_desc";
  after?: string; // opaque cursor bound to sort and filter
  limit?: number; // default 25, maximum 100
};
```

**Response**

```ts
type TenantListResponse = {
  items: Array<{
    id: string;
    businessName: string;
    slug: string;
    status: "active" | "inactive" | "suspended";
    createdAt: string;
    owner: { displayName: string | null; email: string | null } | null;
    activeMemberCount: number;
    latestActivity: { action: string; at: string } | null;
  }>;
  nextCursor: string | null;
};
```

Only return the primary owner and the minimum contact fields needed by staff.
Do not return profile avatars, all member emails, invitation token data,
OAuth data, report content, or raw audit details. Search is limited to
business name and slug, with escaped wildcard characters and a reasonable
minimum/maximum length. Sort choices are allow-listed; never interpolate a
caller-supplied SQL identifier.

**Authorization:** signed-in platform admin with AAL2. No tenant role is
sufficient for a cross-tenant result.

**Pagination:** keyset pagination with a deterministic tie-breaker (`id`) and
an opaque cursor bound to the selected sort and filters. Avoid unbounded
offsets and unrestricted full-text search. Do not expose a cursor as an
authorization token.

**Database effects:** read-only access to `tenants`, owner rows in
`tenant_memberships`, limited `profiles` fields, and a bounded latest-event
projection from `audit_logs`. No writes or audit event.

**RLS and errors:** use a narrowly scoped `SECURITY DEFINER` RPC with an
explicit AAL2 check and fixed query; retain RLS on the source tables. Do not
return details for unauthorized or nonexistent tenant IDs. Return
`42501 ADMIN_MFA_REQUIRED_OR_FORBIDDEN` for unauthorized calls and
`22023 INVALID_FILTER` for invalid filters.

## 4. Tenant activation and deactivation

### Contract: `admin_set_tenant_status`

**Entry point:** new authenticated RPC; one tenant status change per call.

**Request:** `{ tenantId, status, reasonCode, requestId }`, where `status` is
one of the existing values and `reasonCode` is a short allow-listed code (for
example `client_request`, `risk_review`, `operational_pause`, `other`). Do not
put free-form sensitive case notes into audit metadata.

**Response:** `{ tenantId, previousStatus, status, changedAt }`.

**Authorization:** platform admin with AAL2. Only the RPC may change status;
revoke direct authenticated tenant updates in the migration that adds it.

**Transition policy:** allow `active` to `inactive` or `suspended`, either
non-active state to `active`, and `inactive` to `suspended` or vice versa.
Require an explicit reason code for any transition. Repeating the current
status is an idempotent no-op and must not create a duplicate change event.
Every actual transition is audited.

**Effects:** update only `tenants.status` and `updated_at`. Preserve tenant
data, memberships, invitations, Auth users, and external-account records; do
not delete or cascade tenant data. Existing `private.my_tenant_ids()` logic
only authorizes active tenants, and invitation acceptance already rejects
non-active tenants. Client users may still authenticate and access other
active tenants; they cannot access this tenant's data while it is inactive or
suspended. Existing active membership rows remain intact. Reactivation restores
access for still-active memberships; it does not reactivate individually
deactivated members or revive expired/revoked invitations.

Suspend or deactivate should also prevent new user-initiated OAuth, sync, and
report workflows. Scheduled Edge Functions must independently re-check tenant
status before provider calls; status is not a cancellation command for already
running external requests.

**Transaction, RLS, audit:** one transaction updates the tenant; the existing
tenant audit trigger records the before/after status and authenticated actor.
Add reason code through a safe, allow-listed audit field or a purpose-specific
audit projection. No client-supplied actor ID. A status transition does not
require an Edge Function.

**Errors:** `42501 ADMIN_MFA_REQUIRED_OR_FORBIDDEN`; `22023 INVALID_STATUS`,
`INVALID_REASON`, or `TENANT_NOT_FOUND_OR_FORBIDDEN`; `40001 RETRYABLE_CONFLICT`
for a concurrent update where appropriate. Return generic not-found/forbidden
responses.

## 5. Client invitation lifecycle (original proposal; superseded)

> The details in the original proposal below are historical. The remediation
> document is authoritative for the local implementation; in particular, do
> not use the former `create_invitation` response or the former
> `send-tenant-invitation` / `begin_invitation_action` contracts.

### Existing operations

The remediated local source now defines:

- `invite-tenant-member` Edge Function: AAL2 platform-admin only; generates
  the token, hashes it before the service-role RPC, sends the invitation via
  Supabase Auth SMTP, and returns only id/expiry to the browser. The service
  RPC stores only the hash and supports resend through revocation of the
  previous pending row.
- `create_invitation(action_id,tenant_id,email,role,token_hash)`: service-role
  only, requires the matching one-time target-bound action, validates active
  tenant and role, applies the per-inviter rate limit, and returns id/expiry.
- `fail_invitation_delivery(action_id,invitation_id)`: service-role only;
  revokes and audits a pending invitation if Auth email delivery fails.
- `revoke_invitation(invitation_id)`: role-checked transition of a pending
  invitation to revoked.
- `accept_invitation(token)`: authenticated, email-confirmed, normalized-email
  match; one-time token/expiry/status/active-tenant checks; creates or
  reactivates membership without downgrading an existing stronger active role;
  accepts the invitation in the same transaction.
- `expire_stale_invitations()`: service-role-only scheduled expiration.

These are existing source-code contracts, not evidence that 0002 is deployed.

### Historical secure create/resend proposal (not implemented as written)

The raw token returned by the existing authenticated `create_invitation`
function conflicts with the requirement that the browser never receive it.
Do not call that function directly from frontend code. Add a migration that
replaces its browser-executable token-return path with a narrowly scoped
service-only creation RPC, or an equivalently reviewed design with the same
token boundary. Explicitly revoke `authenticated` execution on the existing
raw-token-returning function and ensure no alternate public RPC returns that
token. Grant the replacement creation RPC only to `service_role`.

**Browser API:** `POST /functions/v1/send-tenant-invitation` with
`{ tenantId, email, role, requestId }` and the caller's Authorization header.
On successful delivery return `{ invitationId, expiresAt }` only. The raw
token and full invitation URL are never part of the Edge Function response.
The `requestId` is a UUID reused for retries of the same UI submission.

**Internal RPC contracts:** `begin_invitation_action(tenant_id,email,role)`
runs with the caller JWT and returns `{ actionId, actionExpiresAt }` only
after database authorization and AAL checks. The Edge Function then invokes
`create_invitation_for_action(action_id,request_id,email,role)` with its
service client. That RPC consumes/revalidates the action, applies database
limits and uniqueness, writes the invitation, and returns
`{ invitationId, rawToken, expiresAt }` only to the Edge Function. Neither
internal result is returned to the browser. The action is short-lived,
tenant-bound, one-use for this operation, and bound to the authority checked
by the user-scoped RPC; platform-admin initiation requires AAL2. Tenant
owner/admin authority and allowed role assignment are rechecked when the
service RPC consumes the action.

1. The admin selects a tenant, enters an email, and chooses a role.
2. The browser calls a new `send-tenant-invitation` Edge Function with its
   access token and an idempotency UUID. It sends no actor ID or role claim.
3. The function validates the request and resolves the caller with
   `auth.getUser(jwt)`. It creates an authenticated user client that forwards
   the caller JWT.
4. That user client calls a new, narrow `begin_invitation_action(tenant_id,
   email, role)` RPC. The database checks active tenant, owner/admin or
   AAL2-platform-admin authority, allowed role assignment, and rate limits,
   and records a short-lived action attributed to `auth.uid()`.
5. The function calls a service-only `create_invitation_for_action(...)`
   using its service client. The database revalidates the action, its tenant,
   expiry, actor's current authority, and allowed role assignment; creates the
   invitation and audit row; and returns the raw token only to the Edge
   Function. Extend the privileged-action contract with a distinct invitation
   action or add a separate invitation-action table/function. Do not broaden
   the existing generic manager-level action check to authorize invitations.
6. The Edge Function sends a link using the token in the URL fragment, e.g.
   `/accept-invite#token=...`. Use a provider idempotency key derived from the
   invitation/request ID. Return only `{ invitationId, expiresAt }` to the
   browser.
7. If delivery fails, the Edge Function attempts the existing
   user-authorized `revoke_invitation` using the caller JWT, reports a generic
   delivery failure, and logs only a correlation ID. If compensation fails,
   do not return the token; record the failure safely and let an authorized
   admin resend (which rotates/replaces the pending invite). A process crash
   after creation but before send cannot grant access because no recipient has
   the raw token; the admin can resend, and the unused invite expires. Consider
   a durable, encrypted delivery outbox if operational retry requirements
   justify its additional secret-storage design.

**Roles:** use the existing role enum. Owners may invite permitted roles;
tenant admins may invite only roles below admin; other tenant roles cannot
invite. A platform admin must have AAL2 and may assign only approved client
tenant roles. Do not use arbitrary request values or change role semantics.

**Duplicate and existing-user behavior:** normalize email in the database.
Resend rotates the token and invalidates the previous pending invite. A
confirmed existing Auth user may accept using the matching confirmed email.
An unconfirmed existing account must confirm email first. Unknown addresses
receive the same generic UI response as other successful submissions to avoid
account enumeration; delivery failures are visible as a generic failure to
the authorized inviter. Acceptance for an existing active member must not
downgrade their role; this behavior already exists.

**Expiry and revocation:** retain the existing seven-day expiry and daily
`expire_stale_invitations()` job. Revocation is through the existing
`revoke_invitation` RPC. `deactivate_member` already revokes that member's
pending tenant invitations.

**Acceptance:** the invitee signs in or completes the approved account
onboarding, confirms the email, and submits the fragment token to the existing
`accept_invitation` RPC. Remove the fragment with `history.replaceState`
immediately after capture. Return the resulting tenant ID; refresh
`get_my_context()`. The token is single-use, never logged, never included in an
API response to the browser, and never stored in analytics or error reports.

**Audit and failures:** invitation row triggers audit creation, revoke,
expiry, and acceptance in the same transaction as each state change. The
database audit projection must omit raw tokens, token hashes, email addresses
where not required, and email body/link. The Edge Function must verify JWT,
enforce per-user and per-IP rate limits, exact-origin CORS, and generic
responses. The existing database inviter limit remains in force.

**Errors:** 401 `UNAUTHENTICATED`; 403 `NOT_AUTHORIZED` or
`ADMIN_MFA_REQUIRED`; 409 `INVITATION_ALREADY_PENDING` where not treated as
resend, `IDEMPOTENCY_CONFLICT`, or `INVITATION_NOT_PENDING`; 422
`INVALID_EMAIL` / `INVALID_ROLE`; 429 `RATE_LIMITED`; 502 `EMAIL_DELIVERY_FAILED`.
Acceptance uses the existing generic invalid-or-expired message for missing,
wrong-email, revoked, expired, or inactive-tenant tokens. Never reveal which
token check failed.

### Reused invitation RPC details (unchanged acceptance/revoke operations only)

| RPC | Request and response | Auth / AAL | Tables, transaction, RLS | Audit and retry behavior |
|---|---|---|---|---|
| `revoke_invitation(p_invitation_id uuid)` | Input is the invitation ID; returns `void` | Authenticated tenant owner/admin or platform admin with AAL2 | Locks and updates one pending invitation in one transaction; SECURITY DEFINER must check authority because direct table writes are not allowed | Invitation trigger records revocation in the same transaction. Repeating after terminal state returns `INVITATION_NOT_PENDING`; a retry after an ambiguous network result may therefore need a safe state refresh |
| `accept_invitation(p_token text)` | Input is the raw token; returns the tenant UUID | Authenticated user with confirmed email equal to invite email; no platform-admin AAL requirement | Locks invitation, validates token hash/status/expiry/active tenant, upserts membership and marks invitation accepted in one transaction | Invitation and membership triggers audit changes. Single-use; same token cannot be accepted twice. All invalid-token conditions map to one generic error |
| `expire_stale_invitations()` | No input; returns integer rows expired | `service_role` only; no human AAL | Scheduled server-side RPC updates all pending rows whose expiry has passed in one transaction; never callable by browser/anon | Invitation triggers record each expiration; repeat calls are safe and return zero when no rows qualify |

For all three RPCs, keep the exact authenticated/service-role execution
allow-list in the migration catalog tests. The Edge Function must not replace
database authorization with its own role lookup.

## 6. Tenant members

### Contract: list members

**Entry point:** new `admin_list_tenant_members` RPC, or a tightly scoped
tenant-scoped query under existing RLS for a UI that needs only the current
tenant. The cross-tenant staff dashboard uses the RPC.

**Request:** `{ tenantId, search?, status?, role?, after?, limit? }`.
**Response:** a bounded list of `{ userId, displayName, email, role, status,
createdAt }` plus `nextCursor`. Include email only for staff/tenant managers
whose workflow requires identity matching; do not return Auth metadata.

**Authorization:** AAL2 platform admin for cross-tenant access. A tenant
owner/admin may use only an active tenant and the database-derived tenant
authority. Apply RLS/explicit checks in the RPC.

**Database effects:** read-only joins across `tenant_memberships` and limited
`profiles` columns. No audit entry.

### Existing member changes

Reuse `change_member_role(tenant_id,user_id,role)` and
`deactivate_member(tenant_id,user_id)` as the only member mutation path.
They already enforce owner/admin authority, restrict admins from changing
owners/admins, and rely on `protect_last_owner`; deactivation also revokes
pending invitations. Call them with the user's JWT, never the service role.
Keep the last-active-owner rule in the database for every code path.

The frontend must not directly insert, update, or delete membership rows. The
new migration should review/tighten direct authenticated membership grants so
the policy and grants cannot bypass these RPC invariants.

| RPC | Request and response | Auth / AAL | Tables, transaction, RLS | Audit, idempotency, errors |
|---|---|---|---|---|
| `change_member_role(p_tenant_id uuid, p_user_id uuid, p_role text)` | Tenant ID, target user ID, one existing role; returns `void` | Authenticated tenant owner (any role) or tenant admin (cannot manage owner/admin), or platform admin at AAL2 | Locks target membership and updates role in one transaction; `protect_last_owner` is the final guard; SECURITY DEFINER performs explicit checks | Membership trigger audits actual change. Same role may be treated as no-op in a follow-up migration. Unknown role `22023`; unauthorized `42501`; missing membership `22023`; last-owner violation `23514` |
| `deactivate_member(p_tenant_id uuid, p_user_id uuid)` | Tenant ID and target user ID; returns `void` | Same authority rules as role change | Locks and deactivates membership, revokes that user's pending tenant invitations in one transaction; last-owner trigger applies | Membership/invitation triggers audit changes. Already inactive should be a no-op or stable conflict, decided and tested before UI release; unauthorized `42501`; missing target `22023`; last-owner violation `23514` |

For the new `admin_list_tenant_members` RPC, request fields are tenant ID,
bounded search, optional allow-listed role/status filters, opaque cursor, and
limit (default 25, max 100). It returns the bounded member rows and next
cursor described above. It is read-only and creates no audit entry. Cross-
tenant listing requires platform admin AAL2; a tenant owner/admin may access
only its own active tenant. Invalid filter/cursor returns `22023`; hidden or
unauthorized tenant IDs return the same generic `42501` result.

**Audit:** the existing membership trigger records inserts, role changes, and
deactivation. The audit projection should record target ID, changed role or
status, and tenant ID, but not unrelated profile data.

## 7. Staff administration

### View staff

Add a read-only `admin_list_platform_admins` RPC for the staff UI. Require
`private.is_platform_admin()` (therefore AAL2). Return only user ID, display
name, email, grant date, and grantor needed for staff operations; do not return
Auth metadata, TOTP secrets, recovery codes, or unrelated profile fields.
Existing `platform_admins` RLS permits a platform admin to read the table, but
a dedicated RPC gives the UI an allow-listed response. The existing
`get_my_context()` remains the caller's own context function, not a staff
directory.

**Contract:** no request parameters; response is a bounded array of
`{ userId, displayName, email, grantedAt, grantedBy }`. It reads
`platform_admins` and limited `profiles` fields in one read-only statement.
Require authenticated AAL2 and return `42501 ADMIN_MFA_REQUIRED_OR_FORBIDDEN`
otherwise. RLS continues to protect the underlying rows; the function grants
no write capability. No audit record is generated by a read.

### Add/revoke staff

Do not expose browser-side `INSERT`, `UPDATE`, or `DELETE` on
`platform_admins`. Migration 0002 intentionally keeps it SQL-managed, and
there is no existing RPC for staff changes. For Milestone 2, add/revoke staff
through a two-person-reviewed project-owner procedure outside the dashboard,
with identity verification, confirmed Auth account, verified TOTP enrollment,
explicit operator/change ticket, and post-change audit review.

Before any future automated staff grant/revoke workflow, require owner
approval and a separate threat-model review. A platform administrator must not
be able to grant themselves or another user platform-admin power through an
ordinary tenant-management API. If a future UI is approved, it needs an
independent bootstrap/approval mechanism, not authorization based solely on
the caller being a platform admin.

Add a database guard in a reviewed migration that serializes changes to
`platform_admins` and rejects deleting the final listed administrator. Verify
the replacement is already provisioned with working MFA before the project
owner performs removal. The trigger can guarantee a row remains; it cannot
guarantee that a human retains access to their authenticator or email. Keep a
documented project-owner break-glass recovery procedure. Audit triggers already
record platform-admin table changes when 0002 is present.

**Owner procedure contract:** the project owner selects a confirmed Auth user
whose MFA enrollment has been verified, then uses a reviewed SQL-only grant
or removal script; the actor is the database session, not a browser-supplied
ID. The grant/removal and audit trigger run transactionally. A duplicate grant
is a no-op or explicit duplicate result; removing the final row fails with
`23514 LAST_PLATFORM_ADMIN`. No browser endpoint, user request body, or
service-role workflow is defined for these mutations.

**Errors:** unauthorized reads return `42501 ADMIN_MFA_REQUIRED_OR_FORBIDDEN`.
The guard returns `23514 LAST_PLATFORM_ADMIN`; duplicate grants return
`23505 ALREADY_PLATFORM_ADMIN`. No browser staff mutation endpoint is
specified in this milestone.

## 8. Audit activity

### Required events

At minimum, record:

- Tenant creation and every actual tenant status transition.
- Invitation create/resend, acceptance, revocation, and expiry.
- Membership creation, role change, and deactivation.
- Platform-admin grant and removal.
- Any later staff/tenant operation that changes authorization or lifecycle.

### Record contract

Each event must carry immutable event ID, action, entity type/ID, tenant ID
where applicable, timestamp, actor user ID, and a trusted actor context.
Existing `audit_logs` has `user_id`, `actor_role`, `action`, `entity_type`,
`entity_id`, `details`, `tenant_id`, and `created_at`; 0002 triggers populate
it in the mutating transaction. `actor_role` currently means the JWT role
(typically `authenticated`) or database session role; do not present it as the
tenant role. If staff need an application-level actor category, add a
database-derived `actor_scope` field or safe details value (for example
`platform_admin`, `tenant_owner`, or `tenant_admin`) in a reviewed migration.
Never accept that value from the request body.

Audit writes must be transactionally coupled to the mutation, append-only,
trigger-owned, and unavailable for API insert/update/delete. Preserve access
through existing AAL2 platform-admin RLS and tenant-owner/admin scoping.
Administrative list UI uses a new read-only `admin_list_audit_activity`
function with event filters, keyset pagination, and a small bounded metadata
allow-list; it does not fetch arbitrary `details` JSON.

**Contract:** request contains optional tenant ID (platform-admin use),
action/entity filters, time bounds, opaque cursor, and bounded page size.
Response contains event ID, action, entity type/ID, tenant ID, timestamp,
actor user ID, safe actor context, and allow-listed metadata only. Platform
admin queries require AAL2; tenant-owner/admin queries, if enabled, are
restricted to their active tenant by RLS. The function reads `audit_logs`
only, runs read-only, and creates no audit event. Invalid cursor/filter
returns `22023`; unauthorized or hidden tenant returns a generic `42501`.
Use an opaque keyset cursor with a deterministic timestamp/ID order. No
mutation or idempotency key is applicable.

Replace or harden the existing broad old/new row snapshot audit projection
before exposing these events. Allow only safe changed fields such as status,
role, reason code, and target identifiers. Never record passwords, invitation
tokens or token hashes, OAuth secrets or Vault IDs, provider payloads, request
headers, email bodies, or unbounded free-form text. Avoid raw invitee email in
audit JSON; the invitation table retains the address for its operational
purpose. Actor identity is `auth.uid()` or a validated privileged-action
record, never a caller-provided identity.

For service-role operations done for a user, extend the established
`begin_privileged_action` / `private.use_privileged_action` pattern or create
an equivalently narrow invitation-specific action. Revalidate authority and
tenant/target binding at use time. Scheduled expiry has no human actor and
must be recorded as service-role/system activity with `user_id = NULL`.

## 9. Subscription scope recommendation

Milestone 2 should support **tenant status only**: `active`, `inactive`, and
`suspended`, with the lifecycle behavior defined above. Do not add a
subscription status, plan, invoice, payment, entitlement, or billing table or
present placeholder subscription values as real data.

Treat subscription status and subscription plans/billing as separate future
work. Before adding them, the project owner must approve requirements,
provider, source of truth, entitlement rules, grace-period behavior, and
whether any paid infrastructure is acceptable.

## 10. Operation index and API contracts

This table summarizes all operation boundaries. “New” means a proposed
function or Edge Function, not an existing deployed service.

| Operation | Entry point / status | Transaction and tables | Auth, authorization, MFA | Audit / idempotency |
|---|---|---|---|---|
| Create tenant + owner | New `admin_create_tenant` RPC | Single transaction: `tenants`, `tenant_memberships`, private idempotency record | Authenticated platform admin; AAL2; existing confirmed Auth user for owner | Existing row triggers; request UUID idempotency |
| List tenants | New `admin_list_tenants` RPC | Read-only `tenants`, memberships, profiles, bounded audit projection | Authenticated platform admin; AAL2 | No write; keyset cursor |
| Set tenant status | New `admin_set_tenant_status` RPC | One transaction on `tenants` | Authenticated platform admin; AAL2 | Existing tenant trigger; same status is no-op |
| List tenant members | New `admin_list_tenant_members` RPC or narrowly RLS-scoped read | Read-only memberships/profiles | AAL2 cross-tenant; tenant owner/admin only for own active tenant | No write; keyset cursor |
| Change/deactivate member | Existing `change_member_role`, `deactivate_member` RPCs | One transaction on membership and pending invitations | Authenticated; owner/admin rules or platform admin AAL2 | Existing triggers; repeated final state should be handled safely |
| Create/resend invitation | New `send-tenant-invitation` Edge Function plus new authorization and service-only invitation RPCs | DB creation is one transaction; email is external and cannot be in that transaction | Verified user JWT; owner/admin rules or platform admin AAL2 | DB audit; action/request id; provider idempotency key; safe compensation |
| Revoke invitation | Existing `revoke_invitation` RPC | One transaction on invitation | Authenticated; tenant owner/admin or platform admin AAL2 | Existing invitation trigger |
| Accept invitation | Existing `accept_invitation(text)` RPC | One transaction on invitation and membership | Signed-in user with confirmed matching email; no platform-admin privilege required | Existing triggers; single-use token |
| Expire invitations | Existing `expire_stale_invitations()` service-role RPC | One transaction for eligible rows | Service role only; scheduled server-side job | Existing triggers; naturally repeatable |
| View staff admins | New `admin_list_platform_admins` RPC | Read-only platform-admin/profile fields | Authenticated platform admin; AAL2 | No write |
| Grant/revoke staff | Owner-operated SQL only in this milestone | Project-owner-controlled transaction on `platform_admins` | No browser/API mutation; project owner procedure | Existing trigger; new last-admin guard |
| List audit activity | New `admin_list_audit_activity` RPC | Read-only bounded `audit_logs` projection | AAL2 platform admin; tenant admins only within RLS scope if supported | Append-only source; cursor |

Database RPCs should return typed, bounded structures (or stable table
results), not opaque unrestricted row JSON. All new public functions require
an empty `search_path`, schema-qualified references, explicit execution
grants, and a catalog allow-list test. Do not expose a new function to `anon`.

## 11. Frontend service architecture

Keep the current application shell and add typed service boundaries; do not
put Supabase calls or authorization decisions in page components.

```text
frontend/src/
  services/
    admin/tenantService.ts
    admin/tenantMemberService.ts
    admin/invitationService.ts
    admin/staffService.ts
    admin/auditActivityService.ts
  hooks/admin/
    useTenants.ts
    useTenantMembers.ts
    useInvitations.ts
    usePlatformAdmins.ts
    useAuditActivity.ts
  types/admin/
    tenant.ts
    tenantMember.ts
    invitation.ts
    platformAdmin.ts
    auditActivity.ts
  pages/admin/
    TenantsPage.tsx
    TenantDetailPage.tsx
  components/admin/
    TenantTable.tsx
    TenantStatusControl.tsx
    TenantMemberTable.tsx
    InvitationForm.tsx
    AuditActivityTable.tsx
```

These names are recommendations, not new files in this design task. Fit them
to the existing `src/pages/admin/`, `src/components/`, React Query provider,
and Supabase client conventions.

- `tenantService` calls only the tenant list/create/status RPCs.
- `tenantMemberService` reads bounded member data and calls the existing role
  and deactivation RPCs.
- `invitationService` invokes the Edge Function for create/resend; it may call
  the existing revoke and accept RPCs with the current user session. It must
  never return or store the raw invite token.
- `staffService` is read-only in this milestone. No client-side staff grant or
  removal method.
- `auditActivityService` calls a bounded, paginated RPC; it does not expose
  arbitrary audit JSON.

React Query hooks own cache keys, invalidation, loading/error states, and
pagination. Mutations invalidate the affected tenant, membership, invitation,
and audit queries. Zod schemas validate UI input but do not replace database
validation. UI route guards improve navigation only; PostgreSQL/RLS performs
authorization. Never add a service-role key to frontend environment variables
or bundle output.

## 12. Authorization and RLS requirements

1. Keep RLS enabled on every exposed business table. Preserve tenant scoping
   and composite tenant foreign keys from 0002.
2. `private.is_platform_admin()` is the only platform-admin authorization
   check for database operations and requires AAL2. Check it inside every new
   privileged RPC, not only in the Edge Function or React route.
3. Client tenant reads require an active membership and `tenants.status =
   'active'`. `inactive` and `suspended` tenants retain data but deny client
   access and new invitations.
4. Tenant membership and invitation changes go through existing or new
   role-checking RPCs. Do not trust `user_metadata`, query-string roles, or
   client-submitted actor IDs.
5. Keep OAuth credentials in Vault and `private`; keep service-role use inside
   Edge Functions. Do not expose internal sync logs or unsanitized job errors
   to clients.
6. Keep `audit_logs` trigger-written and append-only. A service-role Edge
   Function does not get permission to forge audit entries.
7. Remove or narrow direct authenticated write grants/policies when adding
   RPCs so direct table calls cannot bypass atomicity, status transition, or
   last-owner/last-admin rules.
8. Every `SECURITY DEFINER` function uses `SET search_path = ''`, fully
   qualified object names, minimal return columns, explicit grants, and
   negative tests for anonymous and cross-tenant callers.
9. Edge Functions verify JWTs with `getUser()`, use the caller's JWT for
   user-authorized operations, apply exact-origin CORS and rate limits, and
   redact credentials/tokens from all logs and errors.
10. Migration 0001 alone has member-read policies for sync job/log data.
    Confirm the hardened policy state before any client-data use; do not
    assume frontend route protection compensates for missing RLS.

## 13. Testing strategy

Add pgTAP/database tests for SQL authorization, transactionality, constraints,
and audit behavior. Add Edge Function tests for JWT forwarding, email
delivery, rate limits, and response redaction. Tests must use disposable local
or isolated test data, never the hosted production database.

| Scenario | Positive case | Negative case / assertion |
|---|---|---|
| Non-admin creates tenant | AAL2 listed admin creates tenant | Client, tenant admin, anonymous, or AAL1 listed admin gets denied |
| Cross-tenant access | Admin sees allowed listing; a tenant admin sees only own tenant | Tenant A cannot list/read Tenant B members, invitations, reports, or audit |
| Duplicate slug | First valid create succeeds | Second create returns conflict; no extra tenant or membership |
| Create idempotency | Same actor/key/payload returns same result | Different payload or actor with same key conflicts |
| Atomic tenant + owner | Valid owner creates both rows and both audit entries | Force membership/audit/constraint failure; tenant, membership, idempotency result all roll back |
| Owner account precondition | Confirmed existing Auth user becomes owner | Missing, duplicate/ambiguous, or unconfirmed owner email fails without partial rows |
| Tenant status | Admin can transition through approved states; reactivation restores eligible membership access | Non-admin/AAL1 cannot change; suspended/inactive tenant cannot read, accept invites, or start sync |
| Duplicate invitation | Resend replaces old pending token and returns one safe email | Concurrent duplicate requests do not create multiple pending rows or leak a raw token |
| Expired/revoked invite | Valid confirmed matching user accepts once | Expired, revoked, wrong-email, inactive-tenant, and replay attempts get the same generic response |
| Role assignment | Owner assigns permitted role; admin assigns only lower roles | Viewer/client cannot invite; admin cannot grant owner/admin; caller cannot elevate own role |
| Email failure | Provider success returns invitation ID/expiry | Provider failure returns no token, revokes when possible, and leaves a safe correlation trail |
| Last tenant owner | Another active owner can be removed while one remains | Any path removing/downgrading/deactivating final active owner is rejected under concurrency |
| Last platform admin | A second provisioned admin is added before removal | Concurrent/ordinary attempts to remove the last listed admin are rejected |
| Audit generation | Tenant/status/invitation/member/staff writes create audit records in same transaction | Direct audit insert/update/delete, actor spoof, raw token/hash/email body in audit are rejected/absent |
| MFA/AAL2 | AAL2 platform admin can perform platform operations | AAL1 listed admin and authenticated non-admin cannot invoke privileged RPCs |
| Invitation token boundary | Edge Function sends token only to email provider | Browser JSON, logs, traces, errors, analytics, and database-readable columns never contain raw token |
| RLS and grants | Expected users read allowed rows and selected columns | `anon`, client, `authenticated` direct writes, and service-only RPC callers fail outside allow-list |

Also test pagination stability, invalid filters, maximum page size, escaped
search text, status no-op audit behavior, and deterministic error mapping.
Update function catalog allow-lists deliberately for each new RPC. No test
should rely on frontend hiding as proof of authorization.

## 14. Implementation sequence

1. **Owner decisions and hosted-state verification:** confirm actual migration
   state through an authorized process; resolve owner account onboarding,
   staff bootstrap, status semantics, email provider, and invitation
   token-delivery architecture. Do not connect or deploy as part of this
   design task.
2. **Threat-model and schema review:** reconcile 0001/0002 behavior and review
   the initial sync-log exposure if 0002 is not present. Approve the exact
   migration plan, grants, audit projection, idempotency store, and
   last-platform-admin guard.
3. **Database contract migration and tests:** add atomic tenant creation,
   list/status/audit/member read RPCs, safe invitation action/token boundary,
   narrow grants, trigger updates, and pgTAP coverage. Do not apply without
   separate explicit approval.
4. **Invitation Edge Function:** implement caller verification, action
   authorization, email provider integration, idempotency/rate limits,
   compensation, restricted CORS, and tests. Keep service secrets server-side.
5. **Frontend services and hooks:** add typed service boundaries and tests
   against the approved response contracts; do not implement admin screens
   until backend contract tests pass.
6. **Admin UI:** implement tenant list/detail/create/status and member/invite
   workflows; expose staff directory read-only and subscription-free.
7. **Security verification and release review:** run database, Edge Function,
   frontend, secret scanning, RLS and AAL2 checks; then request explicit
   deployment authorization and follow the deployment checklist.

## 15. Unresolved decisions requiring project-owner approval

1. **Initial owner account:** require a pre-existing, confirmed Auth user
   (recommended for the atomic contract), or approve a staged onboarding
   design for a not-yet-registered email. Auth Admin API user creation cannot
   share a transaction with tenant membership.
2. **Staff lifecycle:** keep project-owner SQL-only grants/removals (recommended
   for Milestone 2), or authorize a separately designed and reviewed
   staff-approval workflow. Decide whether the last-admin database guard is a
   hard deployment prerequisite.
3. **Invitation delivery:** choose the email provider, sender identity,
   deliverability/retention requirements, per-user/per-IP quotas, and whether
   synchronous delivery plus revoke-and-resend is sufficient or an encrypted
   durable outbox is required.
4. **Tenant status meanings:** confirm operational definitions and which
   circumstances use `inactive` versus `suspended`; approve reason-code values
   and whether a second person must approve suspension/reactivation.
5. **Audit privacy and retention:** approve safe audit field allow-lists,
   whether invitee email is omitted or pseudonymized, actor-scope semantics,
   retention, and audit export requirements.
6. **Subscription scope:** confirm tenant status only for Milestone 2;
   billing, plans, entitlements, and payment-provider decisions remain
   deferred.
7. **Production changes:** approve migrations, hosted verification,
   Edge Function secrets, Auth redirect/MFA settings, email provider
   configuration, and any deployment individually through the established
   checklist.

Until these decisions and migration prerequisites are approved, implement no
tenant-management mutations against a backend and do not claim the hosted
project satisfies this target contract.
