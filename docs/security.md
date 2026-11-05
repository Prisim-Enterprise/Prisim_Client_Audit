# Security

## Principles

1. **The database enforces isolation.** Every table has Row Level Security.
   The frontend is untrusted; hiding a button is never a security control.
2. **Deny by default.** API roles start with no privileges (migration 0002
   revokes Supabase's implicit grants) and receive only explicit grants.
3. **Secrets stay server-side.** The browser only ever holds the publishable
   key and the user's own JWT.
4. **Least privilege for tenant users.** Read-only in the database; changes go
   through Edge Functions that check roles.
5. **Everything security-relevant is audited** in an append-only log.

## Threat model (summary)

| Threat | Control |
|---|---|
| Client reads another client's data | RLS on every table via `private.my_tenant_ids()`; composite FKs stop rows being attached to the wrong tenant; pgTAP tests for every role |
| Client escalates own role | No UPDATE policy on memberships for tenant users; role changes only via Edge Functions or platform admins; roles never read from `user_metadata` |
| Self-service platform-admin grant | `platform_admins` has no INSERT/UPDATE/DELETE grant for API roles; SQL only |
| Suspended client keeps access | All helpers require `tenants.status = 'active'` |
| OAuth token theft | Tokens encrypted in Supabase Vault; mapping table in non-exposed `private` schema; token RPCs executable by `service_role` only; legacy public token columns locked to NULL |
| Invitation token theft or guessing | Only the SHA-256 hash is stored, the hash column is not selectable, tokens are ≥ 32 chars, the invite is bound to a confirmed e-mail, single use, 7-day expiry, one generic error |
| Internal error leakage | `sync_jobs` / `sync_logs` visible to platform admins only; clients use `get_tenant_sync_status()` |
| Report file leakage | Private bucket; read policy checks that the first path segment is a tenant the caller can access; DB constraint keeps `reports.storage_path` inside the tenant folder |
| Audit tampering | `audit_logs` has no UPDATE/DELETE grant, not even for `service_role`; written only by triggers |
| `SECURITY DEFINER` hijack via `search_path` | All definer functions use `SET search_path = ''` and schema-qualified names |
| Open sign-up | Sign-ups disabled; accounts are created only by invitation |

## Keys and secrets

| Secret | Where it lives | Never |
|---|---|---|
| Publishable / anon key | `frontend/.env.local`, Cloudflare Pages env vars | n/a, it is public |
| `service_role` / `sb_secret_...` key | Supabase Edge Functions (injected automatically) | In the frontend, in git, in Cloudflare |
| Database password | Password manager of the project owner | In git, `.env` files, chat or tickets |
| Meta app secret, Google client secret, Google Ads developer token | `npx supabase secrets set NAME=value` | In the frontend or git |
| OAuth access/refresh tokens | Supabase Vault via `store_oauth_tokens` | In `public` tables, logs or API responses |

Git protections: `.gitignore` excludes `.env*` (except `.env.example`),
`supabase/.temp/` and `.env.keys`. Before committing, check `git diff --cached`
for anything that looks like a key.

If a secret leaks: rotate it immediately (Dashboard → Project Settings → API
keys / Database password; regenerate provider app secrets), redeploy Edge
Functions, then review `audit_logs` and Auth logs.

## Authentication settings

`supabase/config.toml` configures **only the local stack**. Set the hosted
project to match in the Dashboard. This is a manual step:

| Setting (Dashboard → Authentication) | Required value |
|---|---|
| Allow new users to sign up | **Off** |
| Minimum password length | 10 or more, with lower/upper/digits |
| Secure password change | On |
| MFA (TOTP) | Enabled; mandatory for platform admins (enforced in the frontend and planned Edge Function checks) |
| Site URL | Production Cloudflare Pages URL |
| Redirect URLs | Production URL + `http://localhost:5173` for development |
| SMTP | A real SMTP provider before go-live (built-in mail is rate-limited and meant for testing) |

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
are recorded in `audit_logs`.

## Applying migrations to production

Only a maintainer applies migrations, and only after review and approval.

```bash
# 1. Validate locally (requires Docker Desktop)
npm run db:start
npm run db:reset          # applies all migrations + seed to the LOCAL database
npm run db:test           # all pgTAP tests must pass
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
