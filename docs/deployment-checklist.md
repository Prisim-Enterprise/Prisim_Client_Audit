# Hosted deployment checklist (Phase 1 security foundation)

This is for the maintainer who applies migration `20261105120000_security_hardening.sql`
to the hosted Supabase project. `supabase/config.toml` configures only the
**local** stack. Nothing below happens automatically, and no step here was run
against the hosted project during development.

Work through the sections in order. Do not push until every box in sections 1–4
is ticked.

---

## 1. Hosted Auth settings (Dashboard → Authentication)

| Where | Setting | Required value | Why |
|---|---|---|---|
| Sign In / Providers → Email | Allow new users to sign up | **Off** | Accounts exist only through invitations. |
| Sign In / Providers → Email | Confirm email | **On** | `accept_invitation` trusts `email_confirmed_at`. With confirmation off, any address is auto-confirmed. |
| Sign In / Providers → Email | Secure email change | **On** (confirm on both addresses) | Stops a user switching their e-mail to an invitee's address without proving ownership. |
| Sign In / Providers → Email | Secure password change | **On** | Requires a recent sign-in to change the password. |
| Sign In / Providers | Anonymous sign-ins | **Off** | Anonymous users get the `authenticated` role. |
| Sign In / Providers | Manual identity linking | **Off** | |
| Sign In / Providers | Every provider except Email | **Off**, unless deliberately planned | |
| Multi-Factor | TOTP (App Authenticator) | **Enabled** (enroll + verify) | Platform-admin privileges require an `aal2` JWT, enforced in the database. Without TOTP, admins have no privileges at all. |
| Multi-Factor | Phone MFA | Off | |
| Passwords | Minimum length | **10+**, lower + upper + digits | |
| Sessions / JWT | Access token (JWT) expiry | **3600 s or less** | Roles, suspension and MFA are re-read from the database on every request, but a stolen JWT stays valid until it expires. |
| URL Configuration | Site URL | Production Cloudflare Pages URL | |
| URL Configuration | Redirect URLs | Exact production URL(s) only, plus `http://localhost:5173` only while developing | No wildcards on shared domains (`*.pages.dev`). Invitation and magic links are sent to these. |
| Emails → SMTP | Custom SMTP | A real provider before go-live | The built-in sender is rate-limited and for testing only. |
| Rate Limits | E-mail / token / verification limits | Keep the defaults or tighter | |

## 2. Hosted Storage and API settings

| Where | Setting | Required value |
|---|---|---|
| Storage → Buckets | `reports` | Private, 20 MiB limit, PDF/CSV/XLSX only. The migration **forces** this even if the bucket already exists. Re-check after the push. |
| Storage → Buckets | Any other bucket | Must not exist, or must be private with reviewed policies. |
| Storage → Policies | `storage.objects` policies | Only the four `reports: …` policies from the migration. Remove dashboard-template policies such as "Allow all authenticated users". They are OR'ed with ours and would bypass tenant isolation. |
| Project Settings → Data API | Exposed schemas | `public`, `graphql_public` only. **Never add `private` or `vault`.** |
| Project Settings → Data API | Max rows | 1000 (default) |
| Project Settings → API Keys | `service_role` / secret key | Present only in Edge Function secrets. Never in the frontend, git or Cloudflare. |
| Database → Extensions | `supabase_vault` | Enabled (default on hosted) |

## 3. Read-only pre-flight on hosted data

The migration aborts (and rolls back) if existing data violates a new
constraint. Run this query in the Dashboard SQL editor **before** pushing. It
only reads and is wrapped in a read-only transaction.

Expected result before the push: **every row is 0**, except the three
`storage:` rows, which are informational. Review those against section 2.

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

If any non-storage row is not 0, fix the data first in a separate, reviewed
step, or stop and ask. Never weaken the migration to make it apply.

## 4. Pre-push verification

- [ ] Sections 1–3 done; the pre-flight shows 0 for every non-storage row
- [ ] Locally, `npm run db:reset`, `npm run db:test` (secret scan + pgTAP + Auth API) and `npm run db:lint` all pass
- [ ] Every hosted tenant has at least one active owner. After the push, the
      last owner can no longer be removed, but tenants that already have none
      are not repaired automatically:
      `SELECT t.id, t.slug FROM public.tenants t WHERE NOT EXISTS (SELECT 1 FROM public.tenant_memberships m WHERE m.tenant_id = t.id AND m.role = 'owner' AND m.status = 'active');`
- [ ] `npx supabase migration list --remote` lists only `202611050001` as applied
- [ ] `npx supabase db push --remote --dry-run` lists only `20261105120000_security_hardening.sql`
- [ ] Hosted schema and data are backed up (see "Applying migrations to production" in `docs/security.md`)
- [ ] At least one PRISIM staff account exists, has **enrolled TOTP**, and is ready to be bootstrapped as platform admin

## 5. Post-push verification (hosted)

- [ ] `npx supabase migration list --remote` shows both migrations applied
- [ ] Dashboard → Advisors → Security shows no errors; new warnings are reviewed
- [ ] Storage → `reports` is private, with the 20 MiB and MIME limits
- [ ] Bootstrap the first platform admin (`docs/security.md`), sign in, complete TOTP, and confirm `get_my_context()` returns `is_platform_admin: true`
- [ ] Sign in as that admin **without** completing TOTP and confirm `is_platform_admin: false` and `platform_admin_mfa_required: true`
- [ ] Schedule `public.expire_stale_invitations()` (service_role) to run daily, once an Edge Function scheduler or `pg_cron` is set up
- [ ] No Edge Function goes live until it meets `docs/edge-function-contract.md`
