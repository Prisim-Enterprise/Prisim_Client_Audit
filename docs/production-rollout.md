# Production rollout: login fix and audit platform

Everything below changes the hosted project, so each step needs explicit
owner approval. **Nothing here has been run.** The authoritative procedure for
the database apply (preflights, backups, restore rehearsal) is
[deployment-checklist.md](deployment-checklist.md); this page lists what the
audit platform adds to it.

## 1. Why login stops at "Account access unavailable"

Sign-in works because Supabase Auth is independent of the schema. Right after
sign-in the frontend calls `rpc("get_my_context")`. The hosted database has
only `202611050001_initial_schema.sql`; `public.get_my_context()` is defined in
the unapplied `20261105120000_security_hardening.sql`, so PostgREST answers
`PGRST202` (function not found) and the app refuses to guess the user's access.

The fix is to apply the pending migrations. No frontend change can or should
bypass this: tenant roles, platform-admin status and the MFA (aal2) rule all
come from that function and the RLS helpers next to it.

After the apply, a signed-in user with no membership sees "No workspace
assigned" until they accept an invitation, and PRISIM staff see admin pages
only after the first-admin bootstrap (step 4) **and** a TOTP-verified session.

## 2. Pending migrations (apply in this order, one `db push`)

| File | Adds | Notes |
|---|---|---|
| `20261105120000_security_hardening.sql` | `get_my_context`, roles, platform admins (aal2), invitations, Vault tokens, privileged actions, append-only audit log, last-owner protection, private `reports` bucket | Local remediation of the three review blockers is in the file. Run checklist phases A–E first. |
| `20261111100000_audit_platform.sql` | `audit_runs`, `audit_findings`, report visibility, analytics RPCs, sync service RPCs, member directory, account selection, Realtime publication | Depends on 0002. Replaces two policies: `Members read reports` and the folder-wide `reports: tenant members read own folder` storage policy (clients now download only reports shared with them). |
| `20261111100100_scheduled_jobs.sql` | `pg_cron` schedules: hourly sync dispatch, daily invitation expiry, daily pruning | Enables `pg_cron` / `pg_net` only if available; otherwise a no-op with a NOTICE. |

Validation done locally without a database: `npm run sql:parse` parses every
migration, function body and pgTAP file with the PostgreSQL 17 parser. The
pgTAP suites (`supabase/tests/database/01`–`10`) still need one run against a
local stack (`npm run db:local:verify`, Docker) before approval — that is the
only way to execute the SQL semantically.

Additional preflight for 0003 (read-only, run with the D-phase queries):

```sql
-- Must return no rows, or the new report-name constraint aborts the migration.
SELECT id FROM public.reports WHERE btrim(report_name) = '' OR char_length(report_name) > 200;
-- Must return NULL, NULL (no name collisions).
SELECT to_regclass('public.audit_runs'), to_regclass('public.audit_findings');
```

Apply (after written approval, as in checklist F1):

```bash
npx supabase db push --remote --dry-run   # must list exactly the three files above
npx supabase db push --remote
```

## 3. Post-apply checks

```sql
SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;
SELECT public.get_my_context();                       -- run from the app, not SQL editor
SELECT jobname, schedule FROM cron.job WHERE jobname LIKE 'prisim-%';
SELECT policyname FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects';
```

Expected storage policies: `reports: members read shared report files`,
`reports: platform admins upload`, `reports: platform admins update`,
`reports: platform admins delete`. Remove any other policy on
`storage.objects` (checklist F2).

## 4. First platform admin

Follow checklist C2/F3 exactly: the staff member signs in, enrolls TOTP at
`/mfa/setup`, then the owner inserts the `platform_admins` row through the
approved SQL process, and the staff member signs in again with the TOTP code.

## 5. Edge Function secrets and deploy

Secrets (names only; values are set by the owner, never committed):

| Secret | Used by | Value |
|---|---|---|
| `APP_URL` | all | Exact Vercel production origin, e.g. `https://portal.prisim.in` |
| `OAUTH_STATE_SECRET` | ad-connections | Random, ≥ 32 characters |
| `CRON_SECRET` | sync-ad-data | Random, ≥ 32 characters (same value as Vault `prisim_cron_secret`) |
| `META_APP_ID`, `META_APP_SECRET` | ad-connections, sync-ad-data | Meta app (Business type) with the Marketing API product |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | ad-connections, sync-ad-data | Google Cloud OAuth client, type Web application |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | ad-connections, sync-ad-data | Google Ads API developer token (Basic access or higher) |
| `META_API_VERSION`, `GOOGLE_ADS_API_VERSION` | optional | Defaults `v26.0` / `v24`; raise when a version nears sunset |

```bash
npx supabase secrets set --project-ref svqzxrkkakfiigrsndzn APP_URL=... OAUTH_STATE_SECRET=... CRON_SECRET=...
npx supabase functions deploy invite-tenant-member ad-connections sync-ad-data run-audit generate-report --project-ref svqzxrkkakfiigrsndzn
```

`sync-ad-data` deploys with `verify_jwt = false` (from `config.toml`) because
pg_cron authenticates with `x-prisim-cron-secret`; the function verifies every
request itself. All other functions keep `verify_jwt = true`.

Vault secrets for the hourly dispatcher (SQL editor, owner only):

```sql
SELECT vault.create_secret('https://svqzxrkkakfiigrsndzn.supabase.co/functions/v1', 'prisim_functions_base_url');
SELECT vault.create_secret('<same value as CRON_SECRET>', 'prisim_cron_secret');
```

Without them the schedule still queues jobs; they run when a sync is started
manually.

## 6. Provider console configuration

- **Redirect URI** for both Meta and Google: `${APP_URL}/oauth/callback`
  (exact match, HTTPS). Add `http://localhost:5173/oauth/callback` only to a
  separate development app/client.
- **Meta**: App Review for `ads_read` (and `business_management` if clients
  use Business Manager), Business Verification, app in Live mode. Until then
  only app admins/testers can connect.
- **Google**: OAuth consent screen with the `https://www.googleapis.com/auth/adwords`
  scope (sensitive scope → verification), developer token with Basic access.
  A test-level token only works with Google Ads test accounts.

## 7. Supabase Auth and Vercel

- Auth → URL configuration: Site URL = `APP_URL`; redirect allow-list contains
  `${APP_URL}/accept-invite` and `${APP_URL}/reset-password` (the OAuth
  callback is not a Supabase Auth redirect). Configure custom SMTP before
  sending real invitations.
- Vercel project root `frontend/`, env vars `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_APP_URL`, `VITE_APP_ENV=production`.
  `frontend/vercel.json` sets the SPA rewrite, a CSP limited to the project's
  Supabase domain, and security headers.

## 8. Free-plan notes

- Sync batches are bounded per invocation (≈110 s wall clock, 5,000 metric rows
  per RPC) and resume on the next hourly tick.
- `private.prune_operational_data()` deletes sync logs older than 90 days and
  expired privileged actions older than 30 days.
- Reports are PDFs of roughly 30–80 KB; the bucket limit is 20 MiB per file.
