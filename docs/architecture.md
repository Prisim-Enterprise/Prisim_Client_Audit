# Architecture

## Overview

```
                    ┌──────────────────────────────────────┐
  Browser           │ Cloudflare Pages                     │
  (staff / client)  │ React SPA (static files only)        │
        │           └──────────────────────────────────────┘
        │  HTTPS, publishable key + user JWT
        ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Supabase project (ap-south-1)                                       │
│                                                                     │
│  Auth ──── issues JWTs (invite-only, e-mail + password, TOTP MFA)   │
│                                                                     │
│  Data API (PostgREST) ──► PostgreSQL 17                             │
│     reads + admin writes   • RLS on every table                     │
│                            • public schema: business data + RPCs    │
│                            • private schema: helpers, credentials   │
│                            • Vault: encrypted OAuth tokens          │
│                            • pg_cron: schedules sync jobs (planned) │
│                                                                     │
│  Storage ── private `reports` bucket, path <tenant_id>/<file>       │
│                                                                     │
│  Edge Functions (Deno) ── the only backend; service_role lives here │
│     invite-user · manage-members · oauth-start · oauth-callback     │
│     sync-runner · generate-report                         (planned) │
└─────────────────────────────────────────────────────────────────────┘
        │  OAuth 2.0, Marketing / Ads APIs
        ▼
  Meta Marketing API  ·  Google Ads API
```

Decisions:

- **Supabase Edge Functions are the only application backend.** No
  Cloudflare Workers, so secrets live in one place.
- **Cloudflare Pages only hosts static files.** It holds no secrets and makes
  no privileged calls.
- **PostgreSQL is the security boundary.** The browser talks to the Data API
  with the user's JWT, and RLS decides what is visible. Frontend route guards
  are only for user experience.

## Tenancy and roles

| Concept | Where | Notes |
|---|---|---|
| Tenant | `public.tenants` | One client business. `status`: active / inactive / suspended. Only `active` tenants are accessible to their users. |
| Membership | `public.tenant_memberships` | User ↔ tenant with a role. A user may belong to several tenants. |
| Platform admin | `public.platform_admins` | PRISIM staff. Cross-tenant access. Granted only via SQL by a project owner. |

Tenant role hierarchy (`private.tenant_role_rank`):

| Role | Rank | Database permissions |
|---|---|---|
| owner | 50 | Everything admin can see. |
| admin | 40 | Read all memberships, invitations and audit log of the tenant. |
| manager | 30 | Read ad-platform connections and teammates' profiles. |
| viewer | 10 | Read dashboards, audit scores, reports. |
| client | 10 | Same as viewer (default role). |

Tenant users have no direct table write access in the database apart from
their own profile name and avatar. Member management (invite, resend, revoke,
change role, deactivate) goes through SQL RPCs: `create_invitation`,
`revoke_invitation`, `change_member_role` and `deactivate_member`. These are
called with the **user's own JWT**, either from the browser or from an Edge
Function that forwards the user's `Authorization` header. The RPCs enforce
rules like "an admin cannot promote someone to owner" and "never remove the
last owner" in SQL, and the audit trail records the real actor.

`service_role` is reserved for work no user can do directly: Vault token
RPCs, creating OAuth connections, starting syncs, scheduled jobs and
invitation expiry. When that work is done for a user, the user first calls
`begin_privileged_action` with their own JWT, and the service-role RPC must
present the returned action id. The audit log then records the initiating
user (`user_id`) and `actor_role = service_role`. Background work is recorded
as `service_role` only. Rules for server code are in
[edge-function-contract.md](edge-function-contract.md).

Platform admins can write business tables directly through the Data API, and
RLS checks `private.is_platform_admin()`, which requires an MFA-verified
(`aal2`) session. Hard deletes of tenants and changes to `platform_admins` are
not possible through the API.

## Key request flows

### Sign-in and session context

1. User signs in with Supabase Auth (e-mail + password; TOTP MFA for staff).
2. The frontend calls `rpc('get_my_context')`, which returns
   `{ is_platform_admin, memberships: [{ tenant_id, business_name, slug, tenant_status, role }] }`.
3. Router: platform admins → `/admin/*`; tenant users → `/app/:tenantSlug/*`;
   suspended tenant → explanatory page.

### Invitation

1. A platform admin, or a tenant owner/admin, calls the `invite-user` Edge
   Function with `{ tenant_id, email, role }`.
2. The function verifies the caller's role, generates a random token, stores
   only its SHA-256 hash in `tenant_invitations`, and sends the e-mail with
   Supabase Auth `inviteUserByEmail` (new user) or a sign-in link (existing user).
3. The invitee sets a password, signs in, and the frontend calls
   `rpc('accept_invitation', { p_token })`.
4. `accept_invitation` checks the token, expiry, confirmed e-mail match and
   tenant status, then creates the membership. It never downgrades an existing
   role.

### Ad-platform connection (planned)

1. A manager+ user starts OAuth via the `oauth-start` function, which uses a
   signed `state` bound to user and tenant.
2. `oauth-callback` exchanges the code, creates or updates
   `oauth_connections`, and calls `store_oauth_tokens` (`service_role` only).
   The tokens are encrypted in Vault and never reach the browser.
3. Discovered ad accounts are written to `ad_accounts`.

### Daily sync (planned)

1. `pg_cron` inserts `sync_jobs` rows and calls `sync-runner` via `pg_net`.
2. `sync-runner` reads tokens with `get_oauth_tokens`, calls the Ads APIs,
   upserts `campaigns` and `daily_metrics` with
   `ON CONFLICT (ad_account_id, campaign_id, metric_date)`, and writes
   `sync_logs`.
3. Clients see only `get_tenant_sync_status()`, never raw job errors.

### Reports (planned)

`generate-report` renders a PDF, uploads it to `reports/<tenant_id>/<report_id>.pdf`
with `service_role`, and sets `reports.status = 'ready'`. Users download it
via the Storage API; the storage policies check the tenant folder.

## Frontend structure (planned, not yet built)

```
frontend/src/
  app/            router, providers (QueryClient, Auth, Tenant)
  lib/            supabase client, typed RPC helpers, env validation
  features/
    auth/         sign-in, reset password, accept invite, MFA
    admin/        tenants, members, invitations, connections, audit log
    portal/       dashboard, campaigns, audit scores, reports
  components/ui/  shadcn/ui components
  types/          generated database types (supabase gen types)
```

Because some columns are protected by column-level grants
(`oauth_connections`, `tenant_invitations`), queries on those tables must list
their columns explicitly. `select('*')` will fail on them.

## Free-tier limits

Limits at the time of writing. Check the current Supabase and Cloudflare
pricing pages before relying on them.

| Constraint | Impact | Mitigation |
|---|---|---|
| Supabase free projects pause after ~7 days without activity | Portal goes offline | Daily `pg_cron` sync keeps it active; upgrade before real clients rely on it |
| 500 MB database | `daily_metrics.source_payload` grows fast | Store raw payloads only for debugging, prune after N days |
| 1 GB storage, 50 MB max file | Report PDFs | 20 MiB bucket limit, retention policy |
| Edge Function invocation and CPU limits | Large syncs | Batch per ad account, resume via `sync_jobs` |
| Auth e-mail rate limit (built-in SMTP is for testing only) | Invites may not send | Configure a free-tier SMTP provider before go-live |
| Meta App Review, Google Ads developer token, Google OAuth verification | External approvals take weeks | Apply early (manual task) |
