# Migration 0002 — Production Deployment Readiness Review

## Executive assessment

**Classification: NO-GO — do not apply migration 0002 to production as written.**

The project owner reports that the Dashboard shows
`202611050001_initial_schema` applied and
`20261105120000_security_hardening` not applied. This review used the local
migration and repository documentation only; it did not connect to Supabase or
independently verify hosted state.

Migration 0002 is broadly compatible with the intended 0001 schema and contains
substantial security controls: tenant-aware constraints, restrictive RLS,
explicit API grants, MFA-gated platform-admin checks, Vault-backed OAuth
credentials, and append-only trigger auditing. It is not safe to approve for
production as written, however:

1. **Invitation token boundary is inconsistent.** The migration grants
   `authenticated` execution on `create_invitation`, and that RPC returns the
   raw token. This conflicts with the Edge Function contract that the raw
   token never be returned to a browser. A signed-in authorized caller can
   invoke the RPC directly and receive it.
2. **OAuth privileged action target binding is incomplete.** An
   `oauth.connect` action is deliberately created with a NULL target, while
   the shared validator skips target comparison whenever the stored target
   is NULL. A later service-role token-store call therefore is not bound by
   the database to the specific connection created for that action.
3. **First platform-admin bootstrap order is ambiguous and can deadlock with
   the current frontend.** The deployment checklist says TOTP enrollment is
   required before F3 inserts the first admin, but the current frontend only
   exposes its TOTP step-up route when the user is already listed as a platform
   admin. The safe bootstrap sequence and its audit attribution need explicit
   owner approval.

These are design/security blockers, not migration execution failures observed
against production. Do not edit or apply the migration as part of this review.
Resolve them through an approved migration/design review and retest the exact
final SQL locally against a production-shaped restore before production
approval.

## 1. Dependency checklist

Confirm all dependencies in the Dashboard and deployment review; none were
checked by connecting during this task.

| Dependency | Requirement / impact |
|---|---|
| PostgreSQL | `UNIQUE NULLS NOT DISTINCT` and column-list `ON DELETE SET NULL (column)` syntax require PostgreSQL 15 or later. Local `supabase/config.toml` specifies 17; verify the hosted server version independently. |
| Migration 0001 | Must be the only preceding migration and match the exact repository version. Migration 0002 references its tables, constraints, indexes, helper and policy names. Resolve discrepancies in migration history before any push. |
| `pgcrypto` | Migration 0001 creates it; 0002 uses `extensions.gen_random_bytes` for invitation tokens and PostgreSQL SHA-256 support. Verify extension/schema availability on the target. |
| Supabase Auth | Requires `auth.users`, `auth.uid()`, `auth.jwt()`, email confirmation fields, confirmed Auth users, and permission to add triggers on `auth.users`. Existing custom Auth triggers may collide with the new trigger names. |
| Supabase Vault | Requires the `supabase_vault` extension and `vault.secrets`, `vault.decrypted_secrets`, and `vault.create_secret`/`update_secret` functions. Migration 0002 creates the extension if absent, but extension installation privileges/availability must be confirmed. |
| Supabase Storage | Requires existing `storage.buckets` and `storage.objects` tables and privileges. The migration modifies/creates the `reports` bucket and creates four policies. |
| API schemas | `private` must remain unexposed through the Data API. `public` is the application API schema. Do not expose `vault` or `private`. |
| Auth configuration | Disable public signup, require confirmed email, enable TOTP, set exact redirect URLs, and review SMTP/rate limits. Platform-admin database authorization requires an AAL2 JWT. |
| Existing custom objects | Check all function, trigger, constraint, policy, and schema name collisions. The migration uses plain `CREATE` for many objects and is not a rerunnable/idempotent script. |
| Maintenance window | The migration adds constraints and indexes and changes grants/policies on many tables. Plan for table scans and locks; use an approved maintenance window. |

Repository sources: [0001](../supabase/migrations/202611050001_initial_schema.sql),
[0002](../supabase/migrations/20261105120000_security_hardening.sql),
[local Supabase config](../supabase/config.toml), and the
[deployment checklist](./deployment-checklist.md).

## 2. Compatibility with migration 0001

The migration expects the 0001 definitions for:

- `tenants`, `profiles`, `tenant_memberships`, `oauth_connections`,
  `ad_accounts`, `campaigns`, `daily_metrics`, `audit_scores`, `sync_jobs`,
  `sync_logs`, `reports`, and `audit_logs`.
- `public.is_tenant_member(uuid)`, which 0002 replaces with an active-tenant-
  aware implementation.
- Named 0001 constraints, including the two audit-log foreign keys and the
  unique daily-metrics key. Missing/renamed constraints cause DDL failure.
- The exact initial RLS policy names that 0002 drops and replaces. The
  profile self-read policy is intentionally kept.

The owner-reported state—0001 applied and 0002 absent—is the expected starting
point. It is not enough by itself: compare hosted migration history, schema
and custom objects with the exact local 0001 baseline first. The checklist's
D1-D3 preflights identify missing history, custom triggers/policies/functions,
and data incompatibilities. Stop on any unexpected migration-history row or
manual schema drift; do not use `migration repair` without separate explicit
approval.

## 3. Table changes and existing-data compatibility

The migration adds:

- `public.platform_admins`.
- `public.tenant_invitations`.
- `private.oauth_credentials`.
- `private.privileged_actions`.
- `profiles.email`, `tenant_memberships.updated_at`,
  `ad_accounts.updated_at`, and `audit_logs.actor_role`.
- New helper/RPC functions, triggers, constraints, indexes, policies and
  default privileges.

Existing data is not broadly deleted. The migration does, however, perform a
profile backfill/upsert from `auth.users` and applies constraints that scan and
validate existing rows. It removes the two `audit_logs` foreign keys so future
tenant/user deletions do not rewrite audit history, and replaces the daily
metrics unique constraint with `UNIQUE NULLS NOT DISTINCT`.

**The following conditions can make the migration fail and roll back:**

- Tenant slugs not matching lowercase kebab-case of length 2–63, or blank
  business names.
- Existing ad-account status/currency values outside the new allow-list.
- Negative metric values or malformed metric currency.
- Audit scores outside 0–100, unsupported platforms, or non-array
  findings/recommendations.
- Unsupported sync job types, negative attempts, or sync log levels outside
  debug/info/warn/error.
- Report statuses outside the new list or storage paths not prefixed by their
  tenant UUID.
- Cross-tenant connection/account/job/campaign relationships that violate the
  new composite foreign keys.
- Duplicate daily metric rows for `(ad_account_id, campaign_id, metric_date)`,
  including duplicate rows with NULL `campaign_id`.
- Any non-NULL legacy encrypted OAuth token value. The migration explicitly
  aborts rather than moving these values into Vault.
- Existing object/constraint/trigger/function/policy names that collide with
  new plain `CREATE` statements.

The repository checklist's D2 and D3 read-only queries are required
preflights. Every incompatibility must be reviewed and repaired through an
approved, separately tested procedure before deployment. Do not silently
delete or coerce production rows to make constraints pass.

Existing tenants without an active owner are not repaired by this migration.
The deployment checklist allows them to remain at migration time and directs
the owner to recovery procedure P1. Resolve the product/access impact before
go-live; adding `protect_last_owner` only guards future membership changes.

## 4. RLS, policies, functions and triggers

### RLS and grants

Migration 0001's named member-read policies for tenants, memberships,
business tables, sync jobs/logs and reports are dropped and replaced.
`profiles` self-read is kept. The new policies give AAL2 platform admins
cross-tenant management and restrict tenant reads through active membership
in active tenants. Sync jobs/logs become staff-only; clients rely on sanitized
sync status. OAuth token columns and `daily_metrics.source_payload` are not
selectable by authenticated clients.

The migration revokes table, sequence and public-function privileges from
`anon`/`authenticated`, then grants a reviewed set of columns, tables and RPCs.
This grant reset is security-critical. Confirm the final access matrix and
function allow-list using the checklist F2 read-only verification and
database catalog tests.

RLS policies are permissive by default and combine with OR semantics.
Unremoved custom public policies could broaden access despite the new policies.
The migration drops only the named 0001 policies. It does not remove arbitrary
policies from `storage.objects`; the checklist correctly requires reviewing
and removing all policies other than the intended four `reports:` policies.
The F2 check should return only those policies.

### Functions and AAL2

`private.is_platform_admin()` requires both a `platform_admins` row and
`auth.jwt()->>'aal' = 'aal2'`. Listed staff at AAL1 have no platform-admin
privileges. `get_my_context()` reports whether step-up is needed. Tenant access
helpers require active membership and an active tenant. SECURITY DEFINER
functions generally use an empty search path and qualified references.

Public API functions are revoked from `PUBLIC`, `anon`, and `authenticated`
then selectively granted. User-context/member/invitation functions are
authenticated; OAuth token and scheduled-expiry functions are service-role
only. Verify the exact deployed allow-list and AAL2 behavior after migration.

### Trigger collisions and behavior

New triggers cover `auth.users` profile create/email changes, timestamps,
invitation transitions, last-owner protection, OAuth secret cleanup, audit
snapshots, and append-only audit logs. The 0001 migration defines no matching
triggers, so a clean 0001 database should not duplicate them. However, the
Auth triggers use plain `CREATE TRIGGER`; an existing starter/custom trigger
with those names will abort the migration. D3 requires checking both named
collisions and all custom Auth triggers.

The audit trigger captures `old`/`new` row JSON and strips token hashes,
legacy OAuth-token columns, Vault IDs, and provider payloads. It does **not**
strip profile email/full name or tenant-invitation email. Treat audit records
as PII-bearing, restrict access/retention accordingly, and resolve the
redaction policy before production use.

## 5. Security findings and required remediation

### Blocker 1: raw invitation token returned to authenticated callers

`create_invitation` returns `invitation_token`; the migration grants
`authenticated` execution. Any authorized tenant owner/admin or AAL2 platform
admin can call it directly through PostgREST and read the raw token. This
contradicts the [Edge Function contract](./edge-function-contract.md), which
requires the token to be emailed only and never returned to the browser.
Email-bound acceptance reduces the impact of a token leak but does not make
the API contract compliant.

Before deploying invitation functionality, replace this path with a reviewed
database/Edge Function design that keeps the token server-side and revoke
authenticated execution on the raw-token-returning function. Do not treat
frontend UI omission as a control.

### Blocker 2: targetless `oauth.connect` action does not bind token storage

`begin_privileged_action` requires `oauth.connect` to have no target.
`private.use_privileged_action` compares a target only if the stored
`target_id` is non-NULL. `create_oauth_connection` consumes the action with a
NULL target, while `store_oauth_tokens` later supplies a connection ID. The
database therefore checks tenant and action type but does not bind that
action to the specific connection whose tokens are stored. A service-role
Edge Function can pass another connection from the same tenant using that
action. This falls short of the migration's target-bound action description
and risks replacing the wrong connection's credentials if a server workflow
uses the wrong ID.

Resolve the binding in an approved migration/design change—e.g. have the
database bind the created connection to the action and enforce that exact ID
when storing tokens—and add negative cross-target tests. Do not rely solely
on Edge Function state correctness.

### Blocker 3: first-admin bootstrap sequence and audit attribution

Migration 0002 creates `platform_admins` empty; it does not provision an
administrator. Until the owner inserts the first row, all platform-admin
operations are unavailable. A listed admin still has no admin authority at
AAL1, which is the intended fail-closed behavior.

The existing deployment checklist's C2/F3 wording is ambiguous: it calls for
TOTP enrollment before the F3 insertion, but the current frontend only exposes
the MFA step-up page when `get_my_context()` says a listed admin requires
step-up. The Dashboard cannot enroll a user's TOTP. Clarify and rehearse this
order: owner creates/confirm staff Auth account; after 0002, owner performs a
single approved bootstrap grant (AAL1 has no admin powers); the staff member
signs in, enrolls/verifies TOTP through the app; verify `get_my_context()` at
AAL1 and AAL2 before using admin operations. Do not grant before 0002 or use a
temporary MFA bypass.

The bootstrap SQL's `granted_by` is nullable and the audit trigger cannot
derive a human identity from a SQL session (`auth.uid()` is NULL). The
bootstrap audit row can show the database session role but not necessarily the
project owner. Record an external change ticket/operator and have the owner
confirm the audit event. A future audited bootstrap mechanism should preserve
operator attribution without accepting a browser-supplied actor.

### Additional security constraints

- TOTP/AAL2 enforcement is database-side, not just a frontend route guard.
  Verify the hosted Auth TOTP setting and an AAL1-denial/AAL2-success test.
- `platform_admins` is intentionally SQL-managed; no browser privilege
  assignment path is granted. There is no last-platform-admin guard in this
  migration. Require a second active admin and a tested owner break-glass
  procedure before revoking any staff access.
- Tenant helpers deny client access to inactive/suspended tenants. Existing
  memberships are retained; reactivation may restore those memberships.
- Vault storage is private, but Vault secrets are not included in the documented
  CLI dump. OAuth connections may need reauthorization after recovery.
- `reports` bucket is forcibly private and constrained to 20 MiB and PDF/CSV/
  XLSX MIME types. Existing public URLs or other policies/clients may stop
  working; review existing storage consumers and objects before applying.

## 6. Data-loss and operational risks

- No normal tenant, campaign, metrics, report, or user rows are deliberately
  deleted by the migration. It does drop two audit-log foreign keys and
  replaces the daily-metrics unique constraint.
- Existing rows violating any new check/FK/unique constraint cause failure;
  they are not automatically repaired. A failed transactional migration
  should leave the database at the prior schema when run through the
  approved Supabase CLI process.
- The profile backfill copies Auth email and name metadata into `profiles`;
  this is a data change and produces profile data on existing users.
- `reports` is changed to private with new limits. Existing files are not
  deleted, but old access patterns may fail.
- OAuth values in legacy public columns cause a hard abort. Do not clear them;
  plan a separately reviewed migration to Vault first if any exist.
- Adding constraints, unique indexes, foreign keys, and grants can take locks
  and block production queries. Use a short approved maintenance window and
  monitor the migration.
- The migration has no down migration. Once applied and followed by new
  writes, reverting is not a safe inverse operation.

## 7. Required backup and rehearsal procedure

Follow [deployment-checklist.md Phase E](./deployment-checklist.md) exactly.
This is a summary, not a replacement for its commands and completeness queries:

1. Confirm backup/PITR plan availability and record the project Auth, Storage,
   API and redirect settings.
2. Run the approved read-only D4 row-count query and save its output.
3. Create encrypted, access-restricted, git-ignored role/schema/data dumps
   using the checklist's Supabase CLI commands. Dumps contain client data,
   Auth password hashes, and MFA secrets. Do not share or commit them.
4. Compare every dumped table row count with the read-only hosted counts.
   Download Storage file contents separately if present; object metadata in
   the data dump is not file content.
5. Restore the dump to an isolated local database based on 0001 and run the
   migration there, then execute the D4/F2 checks. This restore rehearsal is
   required before production deployment.
6. Preserve dump confidentiality and delete temporary copies only under the
   approved retention procedure.

The CLI dumps are **not a complete recovery point**: Vault secrets/OAuth
tokens, Storage file contents, migration history, platform settings, and
managed schemas are excluded or incomplete. A managed PITR/backup, if
available, is preferable but still loses post-restore writes. Document these
gaps and ensure owners accept them before proceeding.

## 8. Required deployment procedure

No deployment was performed. For a future separately approved deployment:

1. Resolve the three blockers in section 5 and review the resulting SQL as a
   new change. Do not deploy the current migration unchanged.
2. Complete deployment-checklist Phases A/B: clean local DB test/lint,
   approved Auth/Storage/API settings, and no secret scan failures.
3. Complete read-only hosted Phases D1-D5: confirm migration history is
   exactly 0001 only; run all data, collision, owner, row-count and dry-run
   checks. Stop on any mismatch. Owner-reported Dashboard status must agree
   with CLI/history evidence; do not repair history without explicit approval.
4. Complete Phase E backup, completeness comparison, and local restore
   rehearsal on the production-shaped data.
5. Confirm all go/no-go checklist items, a maintenance window, and written
   approval naming the exact migration deployment operation.
6. Use only the approved migration path in checklist F1 (Supabase CLI
   `db push --remote` after exact approval). Do not paste the migration into
   Dashboard SQL, run it manually statement-by-statement, run reset/repair, or
   include seed data.
7. If any apply result is unexpected, stop. Do not retry blindly or modify
   migration history; preserve diagnostics and request owner review.

## 9. Post-deployment verification

Run checklist F2 immediately after the authorized apply:

- Confirm hosted migration history shows both 0001 and 0002 applied.
- Run `db lint` and review Dashboard Security Advisors.
- Verify RLS is enabled on every exposed public table and `anon` has no
  privileges or app-function execution.
- Verify authenticated users cannot call OAuth token RPCs, read invitation
  hashes, or write audit logs.
- Verify Vault/legacy token boundaries and report bucket privacy/limits.
- Confirm only intended Storage policies remain; default/example policies
  must not be OR-combined with the tenant policies.
- Verify last-owner, audit append-only, Auth profile triggers, profile
  backfill, and AAL2 helper exactly as checklist F2 specifies.
- Test `get_my_context()` for a regular user, a listed admin at AAL1, and the
  bootstrapped admin at AAL2. Check exact response shape and expected denial/
  step-up behavior without weakening RLS.
- Verify first-admin bootstrap attribution and confirm no platform privilege
  is effective at AAL1.
- Do not enable invitation or OAuth workflows until their related blockers
  and Edge Functions are resolved and security-tested.

## 10. Rollback and recovery limitations

The migration is intended to run in one transaction through the Supabase CLI;
the deployment checklist states a failed apply leaves the database at 0001.
This behavior must be confirmed for the exact CLI/version and deployment path.
Do not infer rollback safety if the operator manually runs statements or the
transaction is interrupted outside the supported process.

After a successful apply, prefer a forward-fix migration. Do not edit 0002
after it has been applied, do not use `migration repair` as a rollback, and do
not assume restoring SQL dumps alone restores the project. Full restore is a
separate destructive, explicitly approved operation. It can lose all changes
after the dump and cannot recover Vault secrets or Storage file contents from
the CLI dumps; restoring Auth data also restores old credentials, sessions,
and MFA factors. Migration history and platform settings need separate
reconciliation. Require a rehearsed restore and owner acceptance before any
restore operation.

## 11. Required manual owner approvals

Before a future production go decision, the project owner must:

- Approve remediation of the raw invitation-token RPC boundary and OAuth
  action-to-connection binding, with tested new migration/function contracts.
- Approve and rehearse the first-admin sequence, confirm named staff identity,
  require TOTP, and record the bootstrap operator/change ticket.
- Verify hosted database version, extension availability, migration history,
  data-preflight results, trigger/policy collisions, custom policies, and
  ownerless tenants through the established read-only procedure.
- Approve backup retention/security and explicitly accept the excluded Vault,
  Storage-content, and platform-setting recovery gaps.
- Confirm Auth, Storage, API-schema exposure, RLS/grants, and redirect settings.
- Approve the local production-shaped restore rehearsal and maintenance
  window.
- Provide written authorization for the exact production migration apply;
  approval of this review or the Dashboard's migration status alone is not
  deployment authorization.

## Final recommendation

**NO-GO for applying migration 0002 as written.** Its broad architecture is
sound in intent and its DDL is designed to fail on incompatible data rather
than silently coerce it, but the raw invitation token exposure, incomplete
OAuth target binding, and unresolved bootstrap sequence prevent production
approval. Resolve these through an approved change, rerun the documented
preflight and full restore rehearsal, then conduct a fresh readiness review.

No SQL was executed, no migration was applied, no hosted project was accessed
or changed, and no credentials or `.env.local` contents were read.
