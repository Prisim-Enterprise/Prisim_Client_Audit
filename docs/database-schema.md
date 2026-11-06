# Database schema

Source of truth: [supabase/migrations/](../supabase/migrations/). This page
explains the schema; if it disagrees with the migrations, the migrations win.

| Migration | Status | Purpose |
|---|---|---|
| `202611050001_initial_schema.sql` | **Applied to hosted. Frozen.** | Core tables, indexes, `is_tenant_member`, read-only RLS |
| `20261105120000_security_hardening.sql` | **Approved and committed. Not yet applied to hosted.** Apply only via [deployment-checklist.md](deployment-checklist.md). | Roles, platform admins, Vault tokens, invitations, storage, integrity, explicit grants |

Items marked *(0002)* below are introduced by the hardening migration.

## Schemas

| Schema | Exposed via Data API | Contents |
|---|---|---|
| `public` | Yes | Business tables, client-callable RPCs |
| `private` *(0002)* | No | Authorization helpers, trigger functions, `oauth_credentials` |
| `vault` | No | Encrypted secrets (Supabase Vault) |
| `storage` | Via Storage API | `reports` bucket objects |

## Entity relationships

```
auth.users ─┬─< profiles (1:1)
            ├─< platform_admins (0..1)                      (0002)
            └─< tenant_memberships >─┐
                                     │
tenants ─┬───────────────────────────┘
         ├─< tenant_invitations                             (0002)
         ├─< oauth_connections ─┬─ private.oauth_credentials (0002, 1:1)
         │                      └─< sync_jobs ─< sync_logs
         ├─< ad_accounts ─< campaigns ─< daily_metrics
         │        └────────────────────< daily_metrics (account-level, campaign_id NULL)
         ├─< audit_scores
         ├─< reports  (file in storage: reports/<tenant_id>/...)
         └─< audit_logs
```

Every child row carries `tenant_id`. *(0002)* Composite foreign keys
`(parent_id, tenant_id) → parent(id, tenant_id)` make it impossible for a
child to point at a parent in another tenant:

- `ad_accounts.connection_id` → `oauth_connections`
- `campaigns.ad_account_id` → `ad_accounts`
- `daily_metrics.ad_account_id` → `ad_accounts`, `daily_metrics.campaign_id` → `campaigns`
- `sync_jobs.connection_id` → `oauth_connections`
- `sync_logs.job_id` → `sync_jobs`
- `private.oauth_credentials.connection_id` → `oauth_connections`

## Tables

| Table | Key columns / constraints |
|---|---|
| `tenants` | `slug` unique, lower-case kebab (0002); `status` active/inactive/suspended |
| `profiles` | `id = auth.users.id`; `email` (0002) is copied from auth by trigger; auto-created on sign-up (0002) |
| `platform_admins` (0002) | `user_id` PK; managed via SQL only |
| `tenant_memberships` | unique `(tenant_id, user_id)`; `role` owner/admin/manager/viewer/client; `status` active/inactive/invited; the last active owner of a tenant cannot be deactivated, downgraded, removed or moved by any role (trigger `protect_last_owner`, 0002) |
| `private.privileged_actions` (0002) | User-initiated authorizations for service_role workflows (`oauth.connect`, `oauth.disconnect`, `sync.start`, `report.generate`); actor from `auth.uid()`; 15-minute expiry; source of audit attribution for service_role work. Not accessible to any API role. |
| `tenant_invitations` (0002) | `email` lower-case; `token_hash` SHA-256 hex of a DB-generated 256-bit token; one pending invite per `(tenant_id, email)`; default expiry 7 days; status only pending → accepted/revoked/expired; other columns immutable (trigger) |
| `oauth_connections` | `provider` meta/google; `status` pending/connected/expired/revoked/error. `encrypted_*_token` columns are **deprecated and must be NULL** (0002) |
| `private.oauth_credentials` (0002) | Vault secret ids for access/refresh tokens; secrets are purged on delete |
| `ad_accounts` | unique `(tenant_id, provider, external_account_id)`; `status` checked (0002); ISO currency (0002) |
| `campaigns` | unique `(ad_account_id, external_campaign_id)` |
| `daily_metrics` | unique **NULLS NOT DISTINCT** `(ad_account_id, campaign_id, metric_date)` (0002), so account-level rows can't duplicate; non-negative metrics (0002); a campaign row must use its campaign's ad account (0002); `source_payload` not selectable through the API (0002) |
| `audit_scores` | `score` 0–100, `platform` meta/google/overall, `findings`/`recommendations` JSON arrays (0002) |
| `sync_jobs` | `status` pending/processing/completed/failed; `job_type` daily_sync/backfill/manual_sync (0002) |
| `sync_logs` | `level` debug/info/warn/error (0002) |
| `reports` | `status` pending/generating/ready/failed (0002); `storage_path` must start with `<tenant_id>/` (0002) |
| `audit_logs` | Append-only (0002), written only by triggers on tenants, profiles, memberships, invitations, platform_admins, oauth_connections, oauth_credentials, ad_accounts, reports and audit_scores. Secrets, token hashes, Vault ids and provider payloads are stripped. `user_id` / `actor_role` come from the JWT. UPDATE/DELETE/TRUNCATE are rejected by triggers. No foreign keys, so rows survive user and tenant deletion unchanged. |

`updated_at` is maintained by triggers on every table that has the column (0002).

## Functions

| Function | Callable by | Purpose |
|---|---|---|
| `public.is_tenant_member(uuid)` | authenticated | Active membership in an **active** tenant (status check added in 0002) |
| `public.get_my_context()` (0002) | authenticated | Caller's platform-admin flag, `platform_admin_mfa_required`, and memberships (with tenant status) |
| `public.get_tenant_sync_status(uuid)` (0002) | authenticated | Per-provider last status and last successful sync, no error details |
| `public.accept_invitation(text)` (0002) | authenticated | Accept an invite by raw token |
| `public.create_invitation(uuid, text, text)` (0002) | authenticated (owner/admin, aal2 platform admin) | Create/resend an invitation; returns the raw token once |
| `public.revoke_invitation(uuid)` (0002) | authenticated (owner/admin, aal2 platform admin) | Revoke a pending invitation |
| `public.change_member_role(uuid, uuid, text)` (0002) | authenticated (owner/admin, aal2 platform admin) | Change a member's role; keeps one active owner |
| `public.deactivate_member(uuid, uuid)` (0002) | authenticated (owner/admin, aal2 platform admin) | Deactivate a member and revoke their pending invitations |
| `public.begin_privileged_action(uuid, text, uuid)` (0002) | authenticated (manager+, aal2 platform admin) | Authorize a service_role workflow; returns an action id |
| `public.expire_stale_invitations()` (0002) | service_role | Mark overdue pending invitations expired (run daily) |
| `public.create_oauth_connection(uuid, uuid, text)` (0002) | service_role | Create a pending connection for an `oauth.connect` action |
| `public.start_sync_job(uuid, uuid, text)` (0002) | service_role | Queue a sync for a `sync.start` action (one queued/running job per connection) |
| `public.store_oauth_tokens(..., p_action_id)` (0002) | service_role | Create or rotate Vault secrets for a connection (active tenant, non-empty access token required; action id for user-initiated connects) |
| `public.get_oauth_tokens(uuid)` (0002) | service_role | Decrypt tokens for a connection |
| `public.delete_oauth_tokens(uuid, uuid)` (0002) | service_role | Purge tokens and mark connection revoked (action id for user-initiated disconnects) |
| `private.is_platform_admin()` (requires `aal2`), `private.is_listed_platform_admin()`, `private.my_tenant_ids(role)`, `private.has_tenant_role(uuid, role)`, `private.can_view_profile(uuid)`, `private.can_read_tenant_object(text)` (0002) | used inside RLS | Authorization helpers (`SECURITY DEFINER`, empty `search_path`) |

## Access matrix (after 0002)

R = read, W = insert/update/delete, — = none. "Members" means users with an
active membership in an **active** tenant; rows are always limited to their
own tenant. "Platform admin" means an `aal2` (TOTP-verified) session; with
`aal1` a listed admin has no admin access. `daily_metrics.source_payload` is
readable only by `service_role`.

| Table | anon | client / viewer | manager | admin / owner | platform admin | service_role |
|---|---|---|---|---|---|---|
| tenants | — | R (own) | R | R | R, W (no delete) | all |
| profiles | — | R/W own | + R teammates | + R teammates | R | all |
| platform_admins | — | R own row | R own row | R own row | R | all |
| tenant_memberships | — | R own row | R own row | R tenant; W via RPCs | R, W | all |
| tenant_invitations | — | — | — | R (no token hash); W via RPCs | R (no token hash); W via RPCs | all |
| oauth_connections | — | — | R (no token columns) | R (no token columns) | R (no token columns), W status, delete | all |
| ad_accounts, campaigns, daily_metrics, audit_scores, reports | — | R | R | R | R, W | all |
| sync_jobs | — | — (status via RPC) | — | — | R, W | all |
| sync_logs | — | — | — | — | R | all |
| audit_logs | — | — | — | R tenant | R | R only (trigger writes) |
| private.oauth_credentials | — | — | — | — | — | — (RPC only) |
| storage `reports` | — | R own folder | R own folder | R own folder | R, W | all |

## Conventions for future migrations

- New file per change, 14-digit UTC timestamp prefix.
- Every new table: `tenant_id` (if tenant data), RLS enabled, explicit
  `GRANT`s, a platform-admin policy and a member policy, a composite FK to
  its tenant-scoped parent, and an `updated_at` trigger if it has the column.
- Every new function in `public`: `SET search_path = ''` and
  `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon;`. `01_structure.test.sql`
  fails if anon can execute any public function.
- Add pgTAP coverage in `supabase/tests/database/` for any new access rule.
