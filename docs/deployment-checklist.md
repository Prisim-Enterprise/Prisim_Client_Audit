# Hosted deployment checklist

**This is the authoritative procedure** for applying migration
`20261105120000_security_hardening.sql` ("0002") to the hosted Supabase
project and for the pre-go-live checks. Other documents link here and do not
repeat it.

Written for the maintainer who performs the deployment. Nothing below happens
automatically, and no step here was run against the hosted project during
development. `supabase/config.toml` configures only the **local** stack.

Work through the phases in order. Stop at the first unexpected result and ask
before continuing.

## Labels

| Label | Meaning |
|---|---|
| 🖥️ LOCAL | Runs on your machine against the local Docker stack only |
| 🧭 DASHBOARD | Manual action in the Supabase Dashboard |
| 🔍 HOSTED READ-ONLY | Reads hosted data or metadata; changes nothing |
| ⚠️ HOSTED WRITE | Changes the hosted project. Needs explicit approval at the time. |

All SQL marked 🔍 is wrapped in `BEGIN READ ONLY; … ROLLBACK;`. Run it in the
Dashboard SQL editor exactly as written. A statement that tries to write
inside a read-only transaction fails instead of changing anything.

## Hard rules

These commands are **never** run against the hosted project unless a separate,
explicit approval names the exact command:

| Never | Why |
|---|---|
| `npx supabase db reset --remote` | Wipes the hosted database |
| `npx supabase migration repair …` (any target) | Rewrites migration history; can make the CLI skip or re-run migrations |
| `npx supabase migration down --remote`, `migration squash --remote` | Destroys or rewrites applied schema and history |
| `npx supabase db push --include-seed` / `--include-all` | Loads local demo data / applies unexpected files |
| `npx supabase test db --remote` | The pgTAP files insert fixture users, tenants and tokens (they roll back, but it is still a write session full of test data) |
| `npm run db:reset`, `npm run db:test`, `db:test:sql`, `db:test:auth` with extra arguments such as `-- --remote` | These scripts are local-only by design. Never append flags to them. `scripts/auth-api.test.mjs` also refuses any non-localhost URL. |
| Pasting `supabase/seed.sql` or any `supabase/tests/**` file into the hosted SQL editor | Local fixtures and demo data only |
| Setting `email_confirmed_at` or editing `auth.*` tables by hand | Bypasses proof of e-mail ownership |

Every hosted command below spells out `--remote` explicitly. Supabase CLI v3
targets the local stack when `--remote` is absent.

---

## Phase A: Local validation 🖥️

```bash
git status --short          # only expected untracked files (e.g. CLAUDE.md)
npm run db:start
npm run db:reset            # LOCAL: applies 0001 + 0002 + seed
npm run db:test             # LOCAL: secret scan + pgTAP + Auth API, all must pass
npm run db:lint             # "No schema errors found"
git diff --quiet HEAD -- supabase/migrations/202611050001_initial_schema.sql && echo "0001 unchanged"
```

Optionally, run the dress rehearsal in Phase E3 once a hosted data dump exists.

## Phase B: Dashboard configuration 🧭

Dashboard menu names change over time. Find each setting by name.

### B1. Authentication

| Setting | Required value | Why |
|---|---|---|
| Allow new users to sign up | **Off** | Accounts exist only through staff creation (Phase C) and invitations |
| Confirm email | **On** | `accept_invitation` trusts `email_confirmed_at`. With confirmation off, every address counts as confirmed. |
| Secure email change (confirm on both addresses) | **On** | Stops a user switching to an invitee's address without proving ownership |
| Secure password change | **On** | Requires a recent sign-in |
| Anonymous sign-ins | **Off** | Anonymous users get the `authenticated` role |
| Manual identity linking | **Off** | |
| Providers other than Email | **Off**, unless deliberately planned | |
| MFA → TOTP (App Authenticator) | **Enabled for enroll and verify** | Platform-admin privileges require an `aal2` JWT, enforced in the database. Without TOTP, admins have no privileges at all. |
| MFA → Phone | Off | |
| Minimum password length / requirements | **10+**, lower + upper + digits | |
| Leaked-password protection | **Enable if your plan offers it** | Plan-dependent. At the time of writing it is not available on every plan. Do not assume it is on. If it isn't available, record "not available on current plan" in the deployment notes and rely on the length and complexity rules. Re-check when the plan changes. |
| Access token (JWT) expiry | **3600 s or less** | Roles, suspension and MFA are re-read from the database on every request, but a stolen JWT stays valid until it expires |
| Site URL | Production frontend URL, or a placeholder you control until the frontend exists | |
| Redirect URLs | Exact production URL(s) only, plus `http://localhost:5173` only while developing | No wildcards on shared domains (`*.pages.dev`). Invitation and magic links go to these. |
| Custom SMTP | A real provider before go-live | The built-in sender is rate-limited and for testing only |
| Rate limits | Defaults or tighter | |

### B2. Storage, API and backups

| Setting | Required value |
|---|---|
| Storage → `reports` bucket | Private, 20 MiB, PDF/CSV/XLSX. The migration forces this even if the bucket exists; re-check after deploy. |
| Storage → other buckets | None, or private with reviewed policies |
| Storage → policies on `storage.objects` | None except the four `reports: …` policies that 0002 creates. Remove dashboard-template policies such as "Allow all authenticated users"; they are OR'ed with ours. |
| Data API → exposed schemas | `public`, `graphql_public` only. **Never `private` or `vault`.** |
| Data API → max rows | 1000 |
| API keys → `service_role` / secret key | Only in Edge Function secrets ([security.md](security.md), "Service-role key and Vault boundary") |
| Extensions → `supabase_vault` | Enabled (default on hosted) |
| Database → Backups | Record what the plan provides (daily backups, point-in-time recovery, or nothing). This is plan-dependent. Do not assume managed backups exist; Phase E is required either way. |

## Phase C: Staff accounts and the first platform admin

### C1. Creating staff accounts when sign-ups are disabled 🧭 ⚠️

Public sign-up is off, so the project owner creates each PRISIM staff account:

1. Dashboard → Authentication → Users → **Add user → Create new user**.
2. Enter the staff member's work e-mail and a strong generated password
   (password manager, 20+ characters). Tick **Auto confirm user**: the
   project owner vouches for staff identity directly.
   **Never auto-confirm client accounts.** Clients join only through
   invitations, which prove e-mail ownership.
3. Share the password only through the password manager. Ask the staff member
   to change it at first opportunity.
4. The `on_auth_user_created` trigger (0002) creates the `profiles` row
   automatically. Accounts created before 0002 are backfilled by the
   migration.

Do not create accounts with the service key from a laptop. Keep the key inside
Edge Functions.

"Send invitation" is the alternative. It needs a working Site URL page to land
on, which does not exist until the frontend is built.

### C2. TOTP is required before admin access (temporary bootstrap) ⚠️

A platform admin has **no** admin privileges until they hold an `aal2`
session, meaning they signed in with password **and** a verified TOTP code. The
frontend MFA screen doesn't exist yet, and the Dashboard can't enroll a factor
on a user's behalf. The first admin therefore needs the temporary enrollment
utility described in [Appendix A](#appendix-a-proposed-temporary-mfa-bootstrap-utility).

**Status: proposed, not implemented.** Until it exists and is approved, Phase
F3 (bootstrap and verify the first admin) cannot be completed. Deploying 0002
does not depend on it: tables, RLS and `service_role` work without a platform
admin.

## Phase D: Read-only checks on hosted 🔍

### D1. Migration history

```bash
npx supabase migration list --remote
```

Expected: one row `202611050001` with both Local and Remote filled, and one row
`20261105120000` with **Local only**.

The same check in SQL:

```sql
BEGIN READ ONLY;
SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version;
ROLLBACK;
```

Expected: exactly one row, `202611050001`.

**Stop and ask** if any of these is true:
- The query fails with "relation does not exist". This means 0001 was applied
  outside the CLI, for example by pasting it into the SQL editor.
- `202611050001` is missing from the history.
- Any other version appears.

The fix may involve `migration repair`, which is **never run without explicit
approval** (see Hard rules). Do not "try" a push to find out.

### D2. Data pre-flight

The migration aborts and rolls back if existing data violates a new
constraint. **Expected:** every row is 0, except the three `storage:` rows,
which are informational (review them against B2).

```sql
BEGIN READ ONLY;
SELECT check_name, problem_rows FROM (VALUES
  ('tenants: invalid slug',            (SELECT count(*) FROM public.tenants WHERE NOT (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 2 AND 63))),
  ('tenants: blank business_name',     (SELECT count(*) FROM public.tenants WHERE btrim(business_name) = '')),
  ('ad_accounts: bad status',          (SELECT count(*) FROM public.ad_accounts WHERE status IS NOT NULL AND status NOT IN ('active','paused','disabled','closed','unknown'))),
  ('ad_accounts: bad currency',        (SELECT count(*) FROM public.ad_accounts WHERE currency IS NOT NULL AND currency !~ '^[A-Z]{3}$')),
  ('ad_accounts: cross-tenant conn',   (SELECT count(*) FROM public.ad_accounts a JOIN public.oauth_connections c ON c.id = a.connection_id WHERE c.tenant_id <> a.tenant_id)),
  ('campaigns: cross-tenant account',  (SELECT count(*) FROM public.campaigns c JOIN public.ad_accounts a ON a.id = c.ad_account_id WHERE a.tenant_id <> c.tenant_id)),
  ('metrics: negative values',         (SELECT count(*) FROM public.daily_metrics WHERE impressions < 0 OR reach < 0 OR clicks < 0 OR spend < 0 OR conversions < 0)),
  ('metrics: bad currency',            (SELECT count(*) FROM public.daily_metrics WHERE currency IS NOT NULL AND currency !~ '^[A-Z]{3}$')),
  ('metrics: cross-tenant account',    (SELECT count(*) FROM public.daily_metrics m JOIN public.ad_accounts a ON a.id = m.ad_account_id WHERE a.tenant_id <> m.tenant_id)),
  ('metrics: campaign/account mismatch',(SELECT count(*) FROM public.daily_metrics m JOIN public.campaigns c ON c.id = m.campaign_id WHERE c.ad_account_id <> m.ad_account_id OR c.tenant_id <> m.tenant_id)),
  ('metrics: duplicate rows',          (SELECT count(*) FROM (SELECT 1 FROM public.daily_metrics GROUP BY ad_account_id, campaign_id, metric_date HAVING count(*) > 1) d)),
  ('audit_scores: invalid',            (SELECT count(*) FROM public.audit_scores WHERE (score IS NOT NULL AND score NOT BETWEEN 0 AND 100) OR (platform IS NOT NULL AND platform NOT IN ('meta','google','overall')) OR jsonb_typeof(findings) <> 'array' OR jsonb_typeof(recommendations) <> 'array')),
  ('sync_jobs: invalid',               (SELECT count(*) FROM public.sync_jobs WHERE attempts < 0 OR job_type NOT IN ('daily_sync','backfill','manual_sync'))),
  ('sync_jobs: cross-tenant conn',     (SELECT count(*) FROM public.sync_jobs j JOIN public.oauth_connections c ON c.id = j.connection_id WHERE c.tenant_id <> j.tenant_id)),
  ('sync_logs: bad level',             (SELECT count(*) FROM public.sync_logs WHERE level NOT IN ('debug','info','warn','error'))),
  ('sync_logs: cross-tenant job',      (SELECT count(*) FROM public.sync_logs l JOIN public.sync_jobs j ON j.id = l.job_id WHERE j.tenant_id <> l.tenant_id)),
  ('reports: invalid',                 (SELECT count(*) FROM public.reports WHERE status NOT IN ('pending','generating','ready','failed') OR (storage_path IS NOT NULL AND storage_path NOT LIKE tenant_id::text || '/%'))),
  ('oauth: tokens in legacy columns',  (SELECT count(*) FROM public.oauth_connections WHERE encrypted_access_token IS NOT NULL OR encrypted_refresh_token IS NOT NULL)),
  ('expected constraint names missing',(SELECT 3 - count(*) FROM pg_constraint WHERE conname IN ('audit_logs_tenant_id_fkey','audit_logs_user_id_fkey','daily_metrics_ad_account_id_campaign_id_metric_date_key'))),
  ('objects this migration creates already exist', (SELECT count(*) FROM pg_class WHERE oid IN (to_regclass('public.platform_admins'), to_regclass('public.tenant_invitations'), to_regclass('private.oauth_credentials')))),
  ('storage: existing reports bucket (info: will be forced private)', (SELECT count(*) FROM storage.buckets WHERE id = 'reports')),
  ('storage: public buckets (review)', (SELECT count(*) FROM storage.buckets WHERE public)),
  ('storage: existing objects policies (review each)', (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname NOT LIKE 'reports:%'))
) AS t(check_name, problem_rows)
ORDER BY problem_rows DESC, check_name;
ROLLBACK;
```

### D3. Name collisions and existing users

0002 uses plain `CREATE FUNCTION`, `CREATE TRIGGER` and `CREATE POLICY`, so an
object with the same name aborts the whole migration. The most likely case is
the `on_auth_user_created` trigger from Supabase starter templates.

**Expected:** 0 for every row except the two `(info)` rows. Any non-zero
non-info row means stop and review before pushing.

```sql
BEGIN READ ONLY;
SELECT check_name, n FROM (VALUES
  ('auth.users: trigger name collision',            (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'auth.users'::regclass AND NOT tgisinternal AND tgname IN ('on_auth_user_created','on_auth_user_email_changed'))),
  ('auth.users: any custom trigger (review)',       (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'auth.users'::regclass AND NOT tgisinternal)),
  ('public: function name collision',               (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('get_my_context','get_tenant_sync_status','accept_invitation','create_invitation','revoke_invitation','change_member_role','deactivate_member','expire_stale_invitations','begin_privileged_action','store_oauth_tokens','get_oauth_tokens','delete_oauth_tokens','create_oauth_connection','start_sync_job'))),
  ('private schema already exists (review)',        (SELECT count(*) FROM pg_namespace WHERE nspname = 'private')),
  ('public: policies not from 0001 (review)',       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND policyname NOT IN ('Users can view own profile','Members can view their tenants','Members can view tenant memberships','Members can view ad accounts','Members can view campaigns','Members can view daily metrics','Members can view audit scores','Members can view sync jobs','Members can view sync logs','Members can view reports'))),
  ('storage: reports: policy name collision',       (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE 'reports:%')),
  ('tenants without an active owner',               (SELECT count(*) FROM public.tenants t WHERE NOT EXISTS (SELECT 1 FROM public.tenant_memberships m WHERE m.tenant_id = t.id AND m.role = 'owner' AND m.status = 'active'))),
  ('auth users with unconfirmed e-mail (info)',     (SELECT count(*) FROM auth.users WHERE email_confirmed_at IS NULL)),
  ('auth users total (info)',                       (SELECT count(*) FROM auth.users))
) AS t(check_name, n) ORDER BY n DESC, check_name;
ROLLBACK;
```

- "tenants without an active owner" > 0 does not block the migration. Plan the
  recovery in [Procedure P1](#p1-tenants-without-an-active-owner).
- "unconfirmed e-mail" > 0: see [Procedure P2](#p2-users-with-unconfirmed-e-mail-addresses).

### D4. Row counts for backup verification

Save the output as `backups/<date>/hosted-row-counts.txt`. Phase E2 compares
the dump against it.

```sql
BEGIN READ ONLY;
SELECT table_name, row_count FROM (VALUES
  ('auth.users',                         (SELECT count(*) FROM auth.users)),
  ('auth.identities',                    (SELECT count(*) FROM auth.identities)),
  ('auth.mfa_factors',                   (SELECT count(*) FROM auth.mfa_factors)),
  ('public.tenants',                     (SELECT count(*) FROM public.tenants)),
  ('public.profiles',                    (SELECT count(*) FROM public.profiles)),
  ('public.tenant_memberships',          (SELECT count(*) FROM public.tenant_memberships)),
  ('public.oauth_connections',           (SELECT count(*) FROM public.oauth_connections)),
  ('public.ad_accounts',                 (SELECT count(*) FROM public.ad_accounts)),
  ('public.campaigns',                   (SELECT count(*) FROM public.campaigns)),
  ('public.daily_metrics',               (SELECT count(*) FROM public.daily_metrics)),
  ('public.audit_scores',                (SELECT count(*) FROM public.audit_scores)),
  ('public.sync_jobs',                   (SELECT count(*) FROM public.sync_jobs)),
  ('public.sync_logs',                   (SELECT count(*) FROM public.sync_logs)),
  ('public.reports',                     (SELECT count(*) FROM public.reports)),
  ('public.audit_logs',                  (SELECT count(*) FROM public.audit_logs)),
  ('storage.buckets',                    (SELECT count(*) FROM storage.buckets)),
  ('storage.objects (metadata only)',    (SELECT count(*) FROM storage.objects)),
  ('vault.secrets (NOT in CLI dumps)',   (SELECT count(*) FROM vault.secrets))
) AS t(table_name, row_count) ORDER BY table_name;
ROLLBACK;
```

### D5. Dry run

```bash
npx supabase db push --remote --dry-run
```

Expected: exactly one file, `20261105120000_security_hardening.sql`, and no
seed. Anything else means stop.

## Phase E: Backup, completeness check and restore rehearsal

### E1. Take the dumps 🔍 (reads hosted, writes local files)

```bash
mkdir -p backups/2026-11-DD
npx supabase db dump --remote --role-only               -f backups/2026-11-DD/roles.sql
npx supabase db dump --remote                           -f backups/2026-11-DD/schema.sql
npx supabase db dump --remote --data-only --use-copy    -f backups/2026-11-DD/data.sql
```

`backups/` is git-ignored. The files contain client data, password hashes and
MFA secrets: keep them on an encrypted disk, never share them, and delete them
when no longer needed.

### E2. What the CLI dumps do and do not contain

Verified against Supabase CLI v3.0.0 with `npx supabase db dump --dry-run`.
Re-check after a CLI upgrade.

| Item | `schema.sql` | `data.sql` | Consequence |
|---|---|---|---|
| `public` and `private` schema objects (tables, functions, RLS, grants) | Yes | — | Also recreated by the migrations themselves |
| Triggers on `auth.users` (`on_auth_user_created`, …) | **No** (the `auth` schema is excluded) | — | Recreated by 0002 |
| Storage buckets and policies on `storage.objects` | **No** (`storage` excluded) | Bucket rows: yes; policies: no | Policies are recreated by 0002 |
| `auth.*` data: users, identities, MFA factors, sessions | — | Yes | Restoring brings back password hashes and TOTP secrets |
| `storage.objects` | — | **Metadata rows only** | **File contents live in object storage and are not in any dump.** Download files separately if any exist (D4 count). |
| `vault.secrets` (OAuth tokens after 0002) | **No** | **No** (`vault` excluded) | Not recoverable from these dumps. Even a copied row would not decrypt in another project, because the encryption key is held by the platform. After a restore, connections must be re-authorized. |
| Migration history (`supabase_migrations`) | **No** | **No** | Must match the restored schema by hand. That is a repair situation, so it needs approval. |
| Other platform schemas (`extensions`, `realtime`, `cron`, `pgsodium`, `graphql`, …) | No | No | Managed by the platform |
| Project settings (Auth, SMTP, API, Storage limits) | No | No | Record them by hand (screenshots/notes of B1–B2) |

**These dumps are not a complete backup.** Treat them as complete only for
`public` and `private` data and `auth`/`storage` rows, and only after E2 and E3
pass.

Completeness check 🖥️. Count rows per table in the dump and compare with
`hosted-row-counts.txt` from D4; every table must match:

```bash
awk '/^COPY /{t=$2; n=0; next} /^\\\.$/{if(t!="")print t, n; t=""; next} t!=""{n++}' \
  backups/2026-11-DD/data.sql | grep -E '"(public|private)"|"auth"\."(users|identities|mfa_factors)"|"storage"\."(buckets|objects)"'
```

If any count differs, or a table is missing, the backup is **not usable**. Stop.

### E3. Local restore rehearsal 🖥️ (required) and dress rehearsal (recommended)

This proves the dump restores, and that 0002 applies cleanly to a copy of
the real data. It runs only against the local Docker stack.

```bash
npm run db:start
# 1. Local database at the hosted state: 0001 only, no demo seed.
npx supabase db reset --version 202611050001 --no-seed
# 2. Load the hosted data dump into the LOCAL database. Use the local
#    superuser: some internal storage tables (storage.buckets_vectors,
#    storage.vector_indexes) are not writable by `postgres`. The dump disables
#    triggers while loading (session_replication_role = replica), so no audit
#    rows or profile triggers fire during the restore.
docker exec -i supabase_db_Prisim_Client_Audit psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
  < backups/2026-11-DD/data.sql
```

This procedure was rehearsed with a local dump (reset to 0001 → dump →
reset to 0001 without seed → restore → `migration up`): the restore exited 0,
row counts matched, and 0002 applied and backfilled profiles.

3. Run the D4 row-count query against the local database. It must equal
   `hosted-row-counts.txt`, except `vault.secrets`.
4. Dress rehearsal: apply 0002 locally on top of the real data, then run the
   F2 verification query locally:
   ```bash
   npx supabase migration up        # LOCAL only (no --remote)
   ```
   Do **not** run `npm run db:test` here. Its fixtures assume an empty
   database, and the point is the real data.
5. Clean up: `npm run db:reset` returns the local stack to demo data. Delete
   the dump files when the deployment is finished.

If step 2 fails because the local `auth` or `storage` schema version differs
from hosted (`supabase/.temp/gotrue-version` and `storage-version` hold the
hosted versions recorded when the project was linked), record it.
The data dump still protects `public`/`private` data, but an `auth` restore is
then unproven.

## Phase F: Deploy and verify

### F0. Go / no-go

All of these must hold:
- [ ] Phase A passes
- [ ] B1 and B2 match. Leaked-password protection is enabled, or its absence on the current plan is recorded.
- [ ] D1 history is as expected, D2 is all zero, and D3 is zero except the info rows
- [ ] D5 lists only 0002
- [ ] E2 counts match and the E3 restore rehearsal passed
- [ ] A short maintenance window is agreed. 0002 briefly takes exclusive locks on most tables.

### F1. Apply ⚠️

```bash
npx supabase db push --remote
```

This is the only command that changes the hosted schema. The file runs as a
single transaction and contains nothing that must run outside one, so a
failure leaves hosted unchanged on 0001.

### F2. Verify 🔍

```bash
npx supabase migration list --remote     # both versions applied
npx supabase db lint --remote            # no errors
```

Dashboard → Advisors → Security: no errors, and new warnings reviewed.
Storage → `reports`: private, 20 MiB, PDF/CSV/XLSX.

Security verification. **Expected: every row is `t`.**

```sql
BEGIN READ ONLY;
SELECT check_name, ok FROM (VALUES
  ('RLS on every public table',              NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity)),
  ('anon has no table privileges',           NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m') AND has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))),
  ('anon executes no app function',          NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public','private') AND has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e'))),
  ('authenticated cannot read OAuth tokens', NOT has_function_privilege('authenticated', 'public.get_oauth_tokens(uuid)', 'EXECUTE')),
  ('service_role cannot write audit_logs',   NOT has_table_privilege('service_role', 'public.audit_logs', 'INSERT,UPDATE,DELETE,TRUNCATE')),
  ('token_hash not readable by API',         NOT has_column_privilege('authenticated', 'public.tenant_invitations', 'token_hash', 'SELECT')),
  ('reports bucket private + 20 MiB',        COALESCE((SELECT NOT public AND file_size_limit = 20971520 FROM storage.buckets WHERE id = 'reports'), FALSE)),
  ('only reports: storage policies',         NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname NOT LIKE 'reports:%')),
  ('last-owner trigger present',             EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'protect_last_owner' AND tgrelid = 'public.tenant_memberships'::regclass)),
  ('audit append-only triggers present',     (SELECT count(*) = 2 FROM pg_trigger WHERE tgrelid = 'public.audit_logs'::regclass AND tgname IN ('audit_logs_append_only','audit_logs_no_truncate'))),
  ('profile triggers on auth.users',         (SELECT count(*) = 2 FROM pg_trigger WHERE tgrelid = 'auth.users'::regclass AND tgname IN ('on_auth_user_created','on_auth_user_email_changed'))),
  ('every auth user has a profile',          NOT EXISTS (SELECT 1 FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id))),
  ('platform admin check requires aal2',     (SELECT prosrc LIKE '%aal2%' FROM pg_proc WHERE oid = 'private.is_platform_admin()'::regprocedure)),
  ('privileged actions table locked down',   NOT has_table_privilege('service_role', 'private.privileged_actions', 'SELECT,INSERT,UPDATE,DELETE'))
) AS t(check_name, ok) ORDER BY ok, check_name;
ROLLBACK;
```

If any row is `f`, do not continue. Recover with a forward fix
([Recovery](#recovery)).

### F3. Bootstrap and verify the first platform admin ⚠️

Requires C1, plus TOTP enrollment by that staff member (C2 / Appendix A).

```sql
INSERT INTO public.platform_admins (user_id, note)
SELECT id, 'Initial PRISIM administrator'
FROM auth.users
WHERE email = 'admin@your-domain.example';
-- expect: INSERT 0 1 (0 means the e-mail did not match; do not retry blindly)
```

Then the staff member checks their own access (Appendix A, `verify` mode):
- signed in with a password only: `get_my_context()` returns
  `is_platform_admin: false`, `platform_admin_mfa_required: true`
- after entering a TOTP code (`aal2`): `is_platform_admin: true`

Remove an administrator with
`DELETE FROM public.platform_admins WHERE user_id = '<uuid>';`. Both changes
are recorded in `audit_logs`.

### F4. Follow-ups

- [ ] Tenants without an active owner from D3: recovered via [P1](#p1-tenants-without-an-active-owner)
- [ ] Schedule `public.expire_stale_invitations()` (service_role) to run daily, once an Edge Function scheduler or `pg_cron` is set up
- [ ] Update the status of 0002 in [database-schema.md](database-schema.md) to "Applied to hosted"
- [ ] No Edge Function goes live until it meets [edge-function-contract.md](edge-function-contract.md)

---

## Recovery

### Preferred: forward-fix migration

If something is wrong after 0002 is applied, write a **new** migration that
corrects it, validate it locally (Phase A, plus the E3 dress rehearsal if data
is involved), and apply it with the same procedure. Never edit 0001 or 0002
after they are applied to hosted.

Forward fixes keep all data written since the deployment, keep migration
history consistent, and go through the same tests as everything else.

### Last resort: restoring a backup (destructive)

Restoring from the Phase E dumps (or a plan-provided backup) is a separate,
explicitly approved operation, never an automatic step. Know the limits first:

- **Data loss:** everything written after the dump is lost: sign-ups, audit
  rows, metrics, invitations.
- **Not a full backup:** Vault secrets (OAuth tokens), storage file contents,
  migration history and project settings are not in the CLI dumps (E2). OAuth
  connections must be re-authorized afterwards.
- **Destructive preparation:** the existing objects must be dropped first, and
  the migration history must be made to match the restored schema. Both are
  high-risk hosted writes, and the second is a repair.
- **Auth risk:** restoring `auth.*` from a dump brings back old sessions, MFA
  factors and password hashes, including any credentials changed since.
- **Unproven unless E3 passed:** a restore that was never rehearsed locally
  must not be attempted on hosted.

A plan-provided point-in-time or daily restore (B2), where available, is
preferable to a manual restore. It still loses data written after the restore
point.

---

## Procedures

### P1. Tenants without an active owner

The `protect_last_owner` trigger (0002) prevents **new** ownerless tenants. It
does not repair existing ones, and deleting an owner's auth account can still
leave one. Owners are restored by hand after confirming, with the client, who
the owner should be.

Identify 🔍:

```sql
BEGIN READ ONLY;
SELECT t.id AS tenant_id, t.slug, t.status AS tenant_status,
       m.user_id, u.email, m.role, m.status AS membership_status
FROM public.tenants t
LEFT JOIN public.tenant_memberships m ON m.tenant_id = t.id
LEFT JOIN auth.users u ON u.id = m.user_id
WHERE NOT EXISTS (SELECT 1 FROM public.tenant_memberships o
                  WHERE o.tenant_id = t.id AND o.role = 'owner' AND o.status = 'active')
ORDER BY t.slug, m.role;
ROLLBACK;
```

Recover ⚠️ (SQL editor, preferably **after** 0002, so the change is audited
with `actor_role = postgres`). Use one of:

```sql
-- Option 1: promote an existing member
UPDATE public.tenant_memberships
SET role = 'owner', status = 'active'
WHERE tenant_id = '<tenant-uuid>' AND user_id = '<user-uuid>';
-- expect: UPDATE 1

-- Option 2: make an existing account the owner (create it first via C1 or an invitation)
INSERT INTO public.tenant_memberships (tenant_id, user_id, role, status)
SELECT '<tenant-uuid>', u.id, 'owner', 'active'
FROM auth.users u WHERE u.email = 'owner@client.example'
ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'owner', status = 'active';
-- expect: INSERT 0 1
```

Re-run the identify query; the tenant must no longer appear. Once a
platform admin with `aal2` and the frontend exist, prefer `create_invitation`
with role `owner`, which proves the owner's e-mail.

### P2. Users with unconfirmed e-mail addresses

Identify 🔍:

```sql
BEGIN READ ONLY;
SELECT u.id, u.email, u.created_at, u.last_sign_in_at,
       (SELECT string_agg(t.slug || ':' || m.role || ':' || m.status, ', ')
        FROM public.tenant_memberships m JOIN public.tenants t ON t.id = m.tenant_id
        WHERE m.user_id = u.id) AS memberships
FROM auth.users u
WHERE u.email_confirmed_at IS NULL
ORDER BY u.created_at;
ROLLBACK;
```

Effects once "Confirm email" is on (B1):
- They cannot sign in with a password until the address is confirmed.
- They cannot accept invitations: `accept_invitation` fails with
  "E-mail address is not confirmed".
- Their existing memberships are kept and become usable once confirmed.

Handling:
1. **Known person:** have them prove ownership by completing an e-mail
   sign-in link sent from Dashboard → Authentication → Users (for example
   "Send magic link"). Then re-run the query to confirm `email_confirmed_at` is set.
2. **Unknown or stale account:** delete it (Dashboard → Users → Delete user)
   after checking its memberships. Account deletion cascades its memberships,
   and the last-owner rule deliberately allows this, so run P1 afterwards.
3. **Never** set `email_confirmed_at` by SQL or tick "auto confirm" for a
   client account. That defeats the invitation e-mail binding.

---

## Pre-go-live checklist

This is the single list for production readiness; it replaces the copies
previously in `security.md`.

- [ ] 0002 applied (F1) and F2 verification all `t`
- [ ] B1 Auth settings match, including the leaked-password protection decision
- [ ] Production SMTP configured
- [ ] First platform admin bootstrapped, with TOTP enrolled and verified (F3)
- [ ] At least two staff members can reach `aal2`, or a recorded recovery path exists for a lost authenticator (Appendix A, "Lost device")
- [ ] Dashboard → Advisors → Security shows no errors
- [ ] Edge Function secrets set; none in the frontend bundle (`npm run check:secrets` passes, including on the built `frontend/dist`)
- [ ] Cloudflare Pages environment variables contain only the public `VITE_*` values
- [ ] `expire_stale_invitations()` scheduled
- [ ] Every Edge Function reviewed against [edge-function-contract.md](edge-function-contract.md)
- [ ] Temporary MFA bootstrap utility removed once the frontend MFA screen exists (Appendix A)

---

## Appendix A: Proposed temporary MFA bootstrap utility

**Status: design only. Not implemented, not approved for hosted use.**

### Problem

Platform-admin privileges require an `aal2` JWT. Getting one requires a
verified TOTP factor. Enrolling a factor needs a signed-in client, which
doesn't exist yet: no frontend, and the Dashboard can't enroll factors for a
user.

### Proposal

A single Node script, `scripts/mfa-enroll.mjs`. It uses **only Node 22
built-ins** (`fetch`, `readline`) and adds no dependencies. It is run by the
staff member themselves, on their own trusted machine, and calls the standard
Supabase Auth endpoints as that user. The same flow is already proven locally
by `scripts/auth-api.test.mjs`, which enrolls TOTP and reaches `aal2` against
the local stack.

### What it needs, and what it never touches

| Input | How it is obtained | Stored? |
|---|---|---|
| Project URL (public) | Prompt (shown) | No |
| Publishable / anon key (public) | Prompt (shown) | No |
| Staff e-mail | Prompt (shown) | No |
| Staff password | Prompt, **hidden input** | No; held in memory for one request |
| TOTP code | Prompt, typed from the authenticator app | No |

- **No service key.** The script refuses any key starting with `sb_secret_`,
  and any JWT whose `role` claim is `service_role`.
- No command-line arguments or environment variables for credentials, so they
  never reach shell history.
- Nothing is written to disk: no logs, no token files, no QR image files.
- It requires `https://` for anything that isn't `127.0.0.1`/`localhost`.
- It never computes TOTP codes itself. The secret is shown once for the
  authenticator app and then discarded. The test script computes codes only
  because it runs against throwaway local users.

### Flow (`enroll` mode)

1. `POST /auth/v1/token?grant_type=password`: e-mail + password → `aal1`
   session. Stop on failure with a generic message.
2. `GET /auth/v1/user`: if a **verified** TOTP factor already exists, stop
   ("already enrolled; use `verify` mode"). Leftover **unverified** factors
   from an earlier attempt are removed with `DELETE /auth/v1/factors/{id}`.
3. `POST /auth/v1/factors` with `{ "factor_type": "totp",
   "friendly_name": "PRISIM admin <date>", "issuer": "PRISIM Client Audit" }`
   returns `{ id, totp: { secret, uri } }`.
4. Print the `otpauth://` URI and the base32 secret **once**, for manual entry
   in the authenticator app. Advise running in a private session and
   clearing the terminal afterwards.
5. Ask for the 6-digit code from the app, then call
   `POST /auth/v1/factors/{id}/challenge` and
   `POST /auth/v1/factors/{id}/verify` with `{ challenge_id, code }`. Allow up
   to 3 attempts. On final failure, delete the unverified factor and exit
   non-zero.
6. Confirm that the returned access token's `aal` claim is `aal2`.
7. `POST /rest/v1/rpc/get_my_context` with the `aal2` token and print only
   `is_platform_admin` and `platform_admin_mfa_required`. Before the F3
   bootstrap, both are `false`; that is expected.
8. Cleanup: `POST /auth/v1/logout` revokes the session and refresh token, and
   in-memory values are cleared.

### `verify` mode (used in F3)

Sign in (`aal1`), then print `get_my_context` and expect
`platform_admin_mfa_required: true` for a listed admin. Challenge and verify
with a fresh code from the app, print `get_my_context` again and expect
`is_platform_admin: true`, then log out. This is the evidence for F3.

### Lost device / backup factor

Supabase TOTP has no recovery codes. While still `aal2`, the utility may
enroll a **second** TOTP factor on another device (Supabase limits the number of
factors per user; the local default is 10). Once a user has a verified factor,
Supabase Auth requires an `aal2` session to enroll another.
If every factor is lost, the project owner removes that user's factors
(Dashboard user actions, or a reviewed hosted SQL write on `auth.mfa_factors`)
and the user enrolls again. That counts as a hosted write and needs approval.

### Verification before any hosted use

1. Implement it, review it, and add it to `npm run check:secrets` coverage
   (it must contain no keys).
2. Rehearse locally: create a user in local Studio, run `enroll` and `verify`
   against `http://127.0.0.1:54321`, and insert that user into the local
   `platform_admins`. Expect the same results as `scripts/auth-api.test.mjs`.
3. Get approval for hosted use. It is a hosted write to that user's own
   `auth.mfa_factors`, made through the Auth API with their own credentials.

### Removal

Delete the script once the frontend has its own MFA enrollment and step-up
screen (see "Frontend notes" in [security.md](security.md)), and tick the
pre-go-live item.
