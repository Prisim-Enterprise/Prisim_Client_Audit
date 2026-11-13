# Architecture

## Overview

```
                    ┌──────────────────────────────────────┐
  Browser           │ Vercel                               │
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
│                            • pg_cron: hourly sync, daily cleanup    │
│                                                                     │
│  Storage ── private `reports` bucket, path <tenant_id>/<file>       │
│                                                                     │
│  Edge Functions (Deno) ── the only backend; service_role lives here │
│     invite-tenant-member · ad-connections · sync-ad-data            │
│     run-audit · generate-report (user JWT; no service_role needed)  │
└─────────────────────────────────────────────────────────────────────┘
        │  OAuth 2.0, Marketing / Ads APIs
        ▼
  Meta Marketing API  ·  Google Ads API
```

Decisions:

- **Supabase Edge Functions are the only application backend.** Secrets live
  in one place.
- **Vercel only hosts the static frontend.** It receives public `VITE_*`
  configuration and makes no privileged calls.
- **PostgreSQL is the security boundary.** The browser talks to the Data API
  with the user's JWT, and RLS decides what is visible. Frontend route guards
  are only for user experience.

## Development and operations

The hosted Supabase project is the normal backend for development and
production. Routine frontend development runs Vite locally and connects to
that hosted project with `VITE_SUPABASE_URL` and the public
`VITE_SUPABASE_PUBLISHABLE_KEY`; `VITE_APP_URL` and `VITE_APP_ENV` describe the
frontend origin/environment. The URL and key are public browser configuration,
not secrets. Never put a service-role key, database password or provider
secret in a `VITE_*` variable.

Docker and the local Supabase stack are not part of routine frontend
development. They remain optional tools for isolated database/migration
validation; database tests and local reset scripts target only that stack.
Database changes must be delivered as reviewed, ordered migrations. Applying
migrations, changing hosted settings, or performing any other production
operation requires explicit authorization and follows
[deployment-checklist.md](deployment-checklist.md).

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
their own profile name and avatar. Revoke, role change and deactivation go
through SQL RPCs called with the **user's own JWT**. Invitation creation is
restricted to an AAL2 platform administrator and runs through the
`invite-tenant-member` Edge Function; its service RPC stores only a token hash.
The SQL RPCs enforce role rules and "never remove the last owner", and the
audit trail records the initiating actor.

`service_role` is reserved for work no user can do directly: Vault token
RPCs, invitation hash storage, creating OAuth connections, starting syncs,
scheduled jobs and invitation expiry. When that work is done for a user, the
Edge Function first calls `begin_privileged_action` with the user's own JWT,
and the service-role RPC must present the returned action id. OAuth actions
are bound to the exact connection they create. The audit log then records the
initiating user (`user_id`) and `actor_role = service_role`. Background work
is recorded as `service_role` only. Rules for server code are in
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

### Invitation (AAL2 platform administrator only)

1. A platform admin calls `invite-tenant-member` with `{ tenantId, email, role }`.
2. The function verifies the caller JWT, obtains an `invitation.create`
   action with AAL2 enforced in SQL, generates a random token, hashes it
   before database storage, and sends via Supabase Auth SMTP.
3. New users receive an Auth invitation; existing users receive an OTP
   sign-in link. The function returns only invitation ID and expiry.
4. The invitee signs in, confirms email, and the frontend calls
   `rpc('accept_invitation', { p_token })`.
5. `accept_invitation` checks the token, expiry, confirmed e-mail match and
   tenant status, then creates the membership. It never downgrades an existing
   role. The acceptance page removes the invitation query token from browser
   history immediately.

### Ad-platform connection

1. A manager+ user (or aal2 staff) calls `ad-connections` `start`. The
   function obtains an `oauth.connect` privileged action with the caller's JWT,
   `create_oauth_connection` creates a pending connection and binds the action
   to it, and the function returns the provider consent URL with an
   HMAC-signed `state` (action, connection, tenant, provider, user, nonce,
   10-minute expiry). Google uses PKCE; the verifier is derived from the
   state nonce, so nothing is stored between requests.
2. Meta/Google redirect to the SPA at `/oauth/callback`, which posts `code`
   and `state` to `ad-connections` `complete` and clears them from the URL.
   The function verifies the signature, expiry and that the caller is the
   user who started, exchanges the code server-side (Meta: long-lived token),
   and stores tokens with `store_oauth_tokens` using the bound action.
3. Discovered ad accounts (Meta `me/adaccounts`; Google accessible customers
   and manager clients with their `login-customer-id`) are written with
   `upsert_discovered_ad_accounts`. The user then selects accounts with
   `set_ad_account_sync` (their own JWT, manager+).
4. `disconnect` uses an `oauth.disconnect` action, asks the provider to revoke
   (best effort) and purges Vault with `delete_oauth_tokens`.

### Sync

1. Manual: `sync-ad-data` `start` -> `sync.start` action -> `start_sync_job`;
   the job is processed after the 202 response with `EdgeRuntime.waitUntil`.
2. Scheduled: pg_cron runs `private.dispatch_scheduled_sync()` hourly, which
   queues due daily jobs (`enqueue_scheduled_sync_jobs`) and calls the
   function through `pg_net` with the `x-prisim-cron-secret` header.
3. The worker claims jobs with `claim_sync_job` (`FOR UPDATE SKIP LOCKED`),
   refreshes Google tokens when they expire, fetches campaigns and daily
   campaign insights (backfill 90 days, manual 30, daily re-reads the last
   7), and upserts them with `ingest_ad_account_data` in batches of 5,000.
   `complete_sync_job` records the result; staff see errors, clients see only
   `get_tenant_sync_status()`.

### Audits

`run-audit` (aal2 staff, their own JWT) reads `get_campaign_performance` /
`get_daily_performance` (SECURITY INVOKER, so RLS applies), runs the shared
audit engine (`supabase/functions/_shared/audit/engine.ts`) and stores a draft
with `save_audit_run`. Staff review findings (severity, dismiss, notes,
summary) and publish with `set_audit_run_status`, which stamps the reviewer,
writes `audit_scores` history and makes the run immutable (trigger). Clients
read published runs and non-dismissed findings only.

### Reports

`generate-report` (aal2 staff, their own JWT) renders the audit with pdf-lib,
uploads `reports/<tenant_id>/<report_id>.pdf` and marks the row `ready`,
`internal` or `client`. A report can be shared only when ready and its audit
is published. Clients download through signed URLs; the storage policy lets a
member read a file only when a matching shared, ready report row exists.

## Frontend structure

```
frontend/src/
  app/            router, query/auth/API providers, route guards
  components/     shared UI, charts, authentication shell, portal layout
  context/        authenticated user, memberships and tenant selection
  lib/api/        PortalApi contract, Supabase implementation, error mapping, realtime hook
  features/       analytics, connections, audits, reports and team panels
  pages/          auth pages, staff (admin/) and client (client/) portals, OAuth callback
  demo/           demo mode only: synthetic fixtures and an in-memory PortalApi
  server/         Vitest suites for the shared Edge Function modules
```

All data access goes through `PortalApi`. The Supabase implementation is used
in local and production modes; `npm run dev:demo` swaps in the demo
implementation. Vite removes the demo branch from every non-demo build, so
production bundles contain no synthetic data.

Because some columns are protected by column-level grants
(`oauth_connections`, `tenant_invitations`), queries on those tables must list
their columns explicitly. `select('*')` will fail on them.

## Free-tier limits

Limits at the time of writing. Check the current Supabase and Vercel
pricing pages before relying on them.

| Constraint | Impact | Mitigation |
|---|---|---|
| Supabase free projects pause after ~7 days without activity | Portal goes offline | Daily `pg_cron` sync keeps it active; upgrade before real clients rely on it |
| 500 MB database | `daily_metrics.source_payload` grows fast | Store raw payloads only for debugging, prune after N days |
| 1 GB storage, 50 MB max file | Report PDFs | 20 MiB bucket limit, retention policy |
| Edge Function invocation and CPU limits | Large syncs | Batch per ad account, resume via `sync_jobs` |
| Auth e-mail rate limit (built-in SMTP is for testing only) | Invites may not send | Configure a free-tier SMTP provider before go-live |
| Meta App Review, Google Ads developer token, Google OAuth verification | External approvals take weeks | Apply early (manual task) |
