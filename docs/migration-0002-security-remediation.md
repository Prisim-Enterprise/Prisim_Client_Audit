# Migration 0002 Security Remediation

## Assessment

Local remediation has been prepared for the three blockers in
[`migration-0002-production-readiness.md`](migration-0002-production-readiness.md).
The changes are confined to the unapplied migration 0002, the invitation Edge
Function, the first-admin MFA route, related tests, and directly affected
documentation. Migration 0001 is unchanged.

**Status: NOT READY FOR PRODUCTION.** This is a local implementation for a
fresh security review. No SQL, database tests, migration, hosted Supabase
operation, email, or deployment was performed. The change needs SQL review and
local database tests before it can be considered for approval.

The migration strategy is to correct 0002 in place because the project owner
reported that 0001 is applied and 0002 is not. Verify migration history for
every environment before release. If any shared environment has applied the
old 0002, stop: do not rewrite its migration history; prepare a separately
reviewed forward migration for that environment.

## Original findings and root causes

1. **Invitation token exposure.** The original authenticated
   `create_invitation` RPC returned `invitation_token` and was executable by
   authenticated users. Token generation, storage, and email delivery did not
   have a strict browser/server boundary.
2. **OAuth target mismatch.** `private.use_privileged_action` checked the
   requested target only when the stored `target_id` was non-NULL.
   `oauth.connect` began targetless, so its action could be used for a
   connection-specific operation without first binding it to that connection.
3. **First-admin MFA deadlock.** The existing MFA page required the account
   context to already identify a platform admin before it would enroll TOTP.
   Yet platform-admin context was required before the owner could grant the
   first `platform_admins` row. SQL-only privilege assignment had no
   last-platform-admin guard.

## Remediation implemented locally

### Invitation creation and delivery

- Added `supabase/functions/invite-tenant-member/index.ts`. It verifies the
  caller through `auth.getUser(jwt)`, asks `begin_privileged_action` to
  authorize `invitation.create` with the caller's own JWT, and accepts no
  caller-supplied actor or action ID.
- The database permits `invitation.create` only for an AAL2 platform admin.
  The action is tenant-bound, short-lived, revalidated at use, then bound to
  the created invitation so it cannot create a second invitation or cancel a
  different one.
- The Edge Function generates a 256-bit token using Web Crypto and calculates
  its SHA-256 hash before calling the database. The revised service-role
  `create_invitation` accepts only that hash, persists it, and returns only
  invitation ID and expiry. It no longer returns or receives the raw token.
- The function uses Supabase Auth's configured SMTP: Auth Admin invitation
  for a new account and passwordless sign-in email with account creation
  disabled for an existing account. It returns only invitation ID and expiry.
  It does not expose email/provider errors or log request data, token, link,
  or message content.
- A send failure calls service-only `fail_invitation_delivery`, which
  revokes the pending invitation and attributes the audit event to the
  initiating administrator. A failed cleanup returns a distinct server
  error rather than reporting a successful cancellation.
- Resends continue to revoke the earlier pending invitation. A per-tenant,
  normalized-email advisory transaction lock serializes concurrent resends;
  the existing uniqueness constraint remains the final guard. The database
  inviter limit remains 30 per hour.
- The invitation email redirect carries the token in the `token` query
  parameter because Supabase Auth returns its own session in the URL fragment.
  `AcceptInvitePage` extracts and removes the query token from browser history
  immediately. The raw token is never returned by an RPC or function response,
  and is not sent to the database. **The recipient must still receive and
  navigate with the token in the email link.** If “the browser never receives
  the raw token” is intended to prohibit even this email-link navigation, the
  current browser-based acceptance design cannot satisfy that literal
  requirement; approve a server-mediated acceptance design before release.

### OAuth privileged-action target binding

- `private.use_privileged_action` now requires exact equality between stored
  and requested targets, including NULL.
- `create_oauth_connection` creates a pending connection for an initially
  targetless `oauth.connect` action, then binds that action to the generated
  connection ID in the same transaction. A second connection creation using
  the action fails.
- `store_oauth_tokens` and other connection-scoped operations must present an
  action bound to the exact connection. Their existing tenant lookup and the
  helper's tenant check reject cross-tenant use.
- The existing audit binding continues to identify the initiating actor and
  target tenant; OAuth tokens remain server-only and stored in Vault.

### First platform-admin MFA bootstrap and final-admin guard

- Added `/mfa/setup`, an authenticated-user TOTP enrollment path that does not
  require a platform-admin context and does not grant application privileges.
  `/mfa` remains the AAL2 step-up route for a listed administrator.
- Revoked `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, and `TRIGGER`
  on `platform_admins` from API roles, including `service_role`. There is no
  browser-side or Edge Function staff-promotion path.
- Added `private.protect_last_platform_admin`, a trigger that serializes
  revocation/reassignment and rejects removal of the final row. It also
  protects the final row from an Auth-user deletion cascade. The project owner
  remains responsible for controlled SQL bootstrap and staff changes.

## First-admin setup sequence

1. After an approved deployment of 0002, the project owner creates and
   verifies the intended staff Auth account through the owner-controlled
   process. Do not assign a platform-admin row yet. Public signup remains
   disabled.
2. The staff member signs in with the owner-issued account and visits
   `/mfa/setup`. They enroll and verify TOTP. At this stage the account is
   still not a platform admin; MFA enrollment alone grants no tenant or staff
   permissions.
3. The owner verifies the intended identity and successful TOTP enrollment,
   then inserts that user into `public.platform_admins` using the
   owner-controlled SQL process and records the operator/change ticket in
   `note`. This SQL action has no authenticated application actor; the ticket
   is the provisioning record.
4. The staff member signs out and signs in again. At AAL1, context must report
   no platform-admin privileges and require MFA. After TOTP step-up at AAL2,
   the platform-admin context and routes become available.
5. To revoke staff access, first verify another valid administrator exists.
   The final row cannot be removed or reassigned; the database trigger also
   blocks deleting that Auth user while they are the last administrator.

No automatic promotion, public admin registration, client-side assignment,
or MFA bypass is introduced.

## Database objects and files affected

### Migration objects

- `private.privileged_actions.action` now includes `invitation.create`.
- `private.use_privileged_action(...)` now performs exact target matching.
- `public.begin_privileged_action(...)` restricts `invitation.create` to AAL2
  platform admins.
- `public.create_invitation(...)` is service-role-only, stores only a supplied
  SHA-256 token hash, and has no raw-token result.
- `public.fail_invitation_delivery(...)` is service-role-only and revokes
  delivery failures against the same target-bound action.
- `public.create_oauth_connection(...)` binds `oauth.connect` to the created
  connection.
- `private.protect_last_platform_admin()` and its trigger protect the final
  administrator.
- API write grants to `public.platform_admins` are explicitly revoked.

### Files

- `supabase/migrations/20261105120000_security_hardening.sql`
- `supabase/functions/invite-tenant-member/index.ts`
- `frontend/src/app/App.tsx`
- `frontend/src/pages/auth/MfaPage.tsx`
- `frontend/src/pages/auth/MfaPage.test.tsx`
- `frontend/src/pages/auth/AcceptInvitePage.tsx`
- `frontend/package.json` and `frontend/package-lock.json` (added the missing
  React Testing Library DOM peer dependency)
- Database tests: `01_structure`, `02_rls_access`,
  `03_invitations_and_tokens`, `04_roles_and_memberships`,
  `06_service_role_vault_audit`, `07_catalog`,
  `08_last_owner`, and `09_privileged_actions`.
- Related documentation: `docs/architecture.md`,
  `docs/database-schema.md`, `docs/deployment-checklist.md`,
  `docs/edge-function-contract.md`, `docs/security.md`, and
  `docs/milestone-2-backend-contracts.md`.

Migration 0001, `.env.local`, and hosted configuration were not changed.

## Security tests added or updated

The database test suite now includes:

| Area | Positive cases | Negative cases |
|---|---|---|
| Invitation authorization and disclosure | AAL2 platform admin creates through a valid service action; response has no token field; only token hash is stored; audit actor is the administrator | Tenant owner/admin and platform-admin AAL1 cannot authorize creation; authenticated role cannot execute service RPC; action cannot be reused for another invite; invalid role, suspended tenant, malformed email rejected |
| Invitation lifecycle | Correct email accepts once; existing stronger role is not downgraded; resend replaces the old token; delivery failure revokes and audits | Wrong email, expired, revoked, reused and suspended-tenant invitations rejected; hash and raw token are absent from audit records |
| OAuth binding | Same action can store tokens only for the connection it created | Targetless action cannot store to a connection; same action cannot create a second connection; cross-tenant connection rejected; wrong purpose, expired action, and lost authorization rejected |
| Platform-admin bootstrap | One of multiple admins can be revoked | API/service-role writes denied; final admin cannot be removed, reassigned, or deleted through an Auth cascade; AAL1 has no admin authority while AAL2 is required for privileged operations |
| MFA setup UI | An account without platform-admin status can enroll TOTP and proceeds only after AAL2 verification | Enrollment does not grant staff or tenant permissions |

First-admin TOTP setup additionally requires an integration rehearsal against
the local Supabase Auth stack: enroll through `/mfa/setup` before inserting
the admin row, verify AAL2, and verify that the account has no privileges
before the owner inserts it. Hosted testing is not authorized by this task.

**Execution status:** the frontend authentication tests passed (4 tests), and
the frontend TypeScript check passed. Database tests were edited but not run;
running them would execute SQL, which was explicitly prohibited for this
task. The Edge Function was not type-checked or run.

## Migration and deployment considerations

- Correct the local unapplied migration 0002 rather than adding a follow-up
  migration, subject to checking that no other environment has applied its
  previous version. Never modify migration 0001.
- Before any owner-approved deployment, inspect the final migration diff,
  run the local database test suite and migration linter against a disposable
  local stack, and rehearse the first-admin and invitation flows. Those checks
  were not run here.
- Configure the Edge Function with `APP_URL`; Supabase supplies its normal
  project URL, anon/publishable key, and service-role secret in the function
  environment. No secret values belong in this repository or frontend.
- Configure Supabase Auth SMTP, email templates, and the exact invitation
  redirect allow-list for `/accept-invite?token=...`. Test new-user invitation
  and existing-user OTP delivery, including SMTP failure cleanup. No email
  was sent and no Auth settings were changed.
- The function relies on database per-inviter limits and Supabase Auth
  throttling. A dedicated shared per-IP limiter is not implemented; do not
  claim one without adding and reviewing that infrastructure.
- The endpoint is not idempotency-keyed. Repeating a successful request
  creates a replacement invitation and invalidates the old token. The UI
  should refresh the invitation state after an ambiguous timeout.
- Review the email-link query-token tradeoff described above. Query tokens can
  appear in browser history until the app strips them and may be exposed to
  infrastructure that records full request URLs. The app removes the token
  immediately and does not log it; a fragment link or server-mediated
  exchange should be reconsidered if Auth redirect behavior or logging
  requirements differ.
- The platform-admin guard's advisory-lock concurrency behavior and trigger
  behavior during Auth cascades require local database test execution and
  review. The SQL-owner role can still alter/drop triggers by design.

## Owner decisions required before production

1. Approve the in-place correction of the unapplied 0002 only after confirming
   it is unapplied in every environment that shares migration history.
2. Approve Supabase Auth SMTP invitation and existing-user OTP behavior,
   templates, redirect allow-list, and the server-side `APP_URL`.
3. Confirm whether the emailed token in the browser's redirect URL is
   acceptable. If not, stop and design a server-mediated acceptance flow.
4. Confirm whether platform admins may invite the `owner` tenant role; the
   current SQL allows the roles already present in the schema.
5. Approve the first administrator's identity and ensure an independent
   owner-controlled recovery path exists before normalizing the final-admin
   guard.
6. Decide whether a shared per-IP invitation limiter and delivery idempotency
   are launch requirements.

## Completion record

- No SQL was executed.
- No migration was applied.
- No hosted Supabase connection or change was made.
- No invitation email was sent.
- No credentials or environment files were read, written, or disclosed.
- No commit, push, or deployment was performed.

## Independent review and local validation — 2026-11-10

**Classification: NO-GO.** The independent reviewer found no vulnerabilities
in the reviewed local changes, but this validation does not establish
migration readiness: the migration was not applied to a disposable local
database, the pgTAP suite was not run, and end-to-end Auth email and OAuth
callback behavior could not be verified.

### Independent security review

The independent reviewer inspected the invitation token workflow, OAuth
privileged-action target binding, and first-admin MFA/bootstrap controls.
Their conclusion was that the database controls in the reviewed SQL and tests
appear sound, with **no confirmed security vulnerabilities**. This is a
static review conclusion, not proof from executed database tests.

Open integration checks identified by the reviewer:

- The invite function requests `/accept-invite?token=…`, while the local
  `supabase/config.toml` redirect allow-list contains only root URLs. Confirm
  the exact redirect is permitted in the target Auth configuration and that
  the configured email template actually uses the supplied custom redirect.
  The email click-through was not verified; this may prevent or misroute
  invitation acceptance.
- No local OAuth callback/exchange implementation was found. The reviewer
  assessed the database-side target binding only; end-to-end OAuth exchange
  and callback behavior remain outside the verified scope.

### Validation executed

- Frontend tests: `npm run test` in `frontend/` — passed, 3 test files and
  8 tests.
- Frontend TypeScript: `npm run typecheck` in `frontend/` — passed.
- `git diff --check` — passed.
- Migration 0001 integrity check — unchanged.
- Independent security review — completed; no confirmed vulnerabilities in
  the reviewed local controls, with the integration gaps listed above.

### Validation not executed

- **Local migration application and pgTAP suite:** Docker CLI is present, but
  the Docker daemon is unavailable. The Supabase CLI is available through
  the repository's npm dependency, but no SQL or migration command was run.
  A running local Docker daemon is still a prerequisite.
- **Edge Function checks:** Deno is not installed. The function was not
  type-checked or run; no email/Auth delivery was attempted. Deno and a
  test-only mocked Auth delivery boundary are prerequisites.
- **Auth email delivery and click-through:** not tested; no email was sent.
  Custom redirect allow-list and template behavior need environment-level
  verification.
- **OAuth callback/exchange:** no local implementation was available for
  review; only the database-side privileged-action binding was assessed.

### Findings and remaining risks

No confirmed vulnerability was reported by the independent reviewer.
Previously documented risks remain open, including the invitation token in
the acceptance URL, custom redirect allow-list/template compatibility,
invitation delivery/cleanup behavior, the missing locally verifiable OAuth
callback/exchange, and untested database constraints, grants, triggers, and
advisory-lock behavior. No production approval should be inferred from the
passing frontend checks or static review.

Migration 0002 was not applied or tested for compatibility with migration
0001 in a local database. Migration 0001 remains unchanged. This validation
changed only this documentation file; application source, SQL migrations,
database tests, and environment files were not edited during this validation.

## Production connection and migration status — 2026-11-10

The Supabase CLI reports the linked production project as
`svqzxrkkakfiigrsndzn` (`Prisim_Client_Audit`, production). The hosted
migration-history listing reports `202611050001` applied and
`20261105120000` pending. This is history metadata only; it does not establish
that migration 0002 is safe to apply.

Production checks used the explicitly linked project and were read-only:

- The migration dry-run targeted `svqzxrkkakfiigrsndzn` and listed only
  `20261105120000_security_hardening.sql`; no seed or Vault update was planned.
- Read-only compatibility checks returned zero for the tested constraint/data
  violations, expected object-name collisions, Auth user trigger collisions,
  unexpected public/storage policies, missing prerequisite constraints, and
  tenants without an active owner. Supabase Vault is installed and the
  Storage schema exists; no `reports` bucket currently exists.
- Auth health returned HTTP 200. An unauthenticated `get_my_context()` RPC
  probe returned HTTP 404 / `PGRST202` (function absent from the schema cache),
  consistent with migration 0002 being pending. No user identity or
  row-level private business data was retrieved; migration preflight queries
  returned aggregate counts only.
- The ignored local frontend environment was configured with the production
  URL and publishable key without printing or committing the key. Local Vite
  rendered the login screen. Frontend tests passed (15 tests), TypeScript
  passed, and the production-mode build passed.

Migration 0002 remains **NO-GO**: the production dry-run is a migration plan,
not an execution test. Local pgTAP and Edge Function checks remain unrun, and
authenticated login, profile/membership RLS, and admin MFA routes could not be
verified without an owner-authorized dedicated test account. Backup status and
first-admin bootstrap readiness were not verified. No migration or other
production write was performed.
