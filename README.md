# PRISIM Client Audit Portal

A multi-tenant portal where PRISIM staff audit client advertising accounts
(Meta and Google Ads) and clients see their own dashboards, audit scores and
reports.

- **PRISIM staff** (platform administrators) manage every client tenant.
- **Client users** belong to one or more tenants and only ever see their own
  tenant's data, with permissions set by their tenant role.

> **Status:** foundation stage. The database schema exists; the hardening
> migration `20261105120000_security_hardening.sql` is **proposed, pending
> approval**. The frontend and Edge Functions are not built yet.

## Stack

| Layer | Technology | Hosting (free tier) |
|---|---|---|
| Frontend | React, TypeScript, Vite, Tailwind CSS, shadcn/ui, React Query, React Router | Cloudflare Pages |
| Auth | Supabase Auth (e-mail + password, invite-only) | Supabase |
| Database | Supabase PostgreSQL 17 with Row Level Security | Supabase |
| Files | Supabase Storage (private `reports` bucket) | Supabase |
| Backend | Supabase Edge Functions (Deno), the only backend | Supabase |
| Secrets | Supabase Vault (OAuth tokens), Edge Function secrets | Supabase |

Initial infrastructure budget is ₹0. See [docs/architecture.md](docs/architecture.md#free-tier-limits)
for the limits that implies.

## Repository layout

```
.
├── docs/
│   ├── architecture.md       System design, request flows, roles
│   ├── database-schema.md    Tables, relationships, RLS matrix
│   └── security.md           Threat model, secrets, operational rules
├── frontend/                 React app (not yet scaffolded)
│   └── .env.example          Public frontend environment variables
├── supabase/
│   ├── config.toml           Local development stack configuration
│   ├── migrations/           Ordered SQL migrations (source of truth)
│   ├── seed.sql              Local-only demo data
│   └── tests/database/       pgTAP tests (RLS, integrity, invitations, vault)
└── package.json              Supabase CLI (dev dependency) and local scripts
```

## Prerequisites

- Node.js 20+ (22 recommended)
- Docker Desktop, only for running the local Supabase stack and database tests
- Access to the Supabase project (for maintainers who apply migrations)

## Local development

```bash
npm install                 # installs the Supabase CLI locally
npm run db:start            # starts local Supabase in Docker (first run downloads images)
npm run db:reset            # rebuilds the local DB from migrations + seed.sql
npm run db:test             # runs pgTAP tests in supabase/tests/database
npm run db:lint             # static checks on database functions
npm run db:stop             # stops local Supabase
```

Local services after `db:start`:

| Service | URL |
|---|---|
| API | http://127.0.0.1:54321 |
| Studio | http://127.0.0.1:54323 |
| Mail catcher (invite / reset e-mails) | http://127.0.0.1:54324 |

Signups are disabled (invite-only). Create local users in Studio, then link
them to demo tenants with the snippet at the bottom of
[supabase/seed.sql](supabase/seed.sql).

Frontend setup will be documented here once it is scaffolded. Its
environment variables are listed in [frontend/.env.example](frontend/.env.example).

## Database change workflow

1. Never edit a migration that has been applied to the hosted project
   (`202611050001_initial_schema.sql` is applied and frozen).
2. Add a new file `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`.
3. Validate locally: `npm run db:reset && npm run db:test`.
4. Get the change reviewed and approved.
5. A maintainer applies it to the hosted project. See
   [docs/security.md](docs/security.md#applying-migrations-to-production).

The npm scripts never touch the hosted database. There is intentionally no
`db push` script.

## Security essentials

- Only **public** keys go in the frontend (`VITE_*`). Service-role keys,
  database passwords and OAuth client secrets live only in Supabase Edge
  Function secrets.
- Tenant isolation is enforced by PostgreSQL Row Level Security, not by the
  UI.
- Full details: [docs/security.md](docs/security.md).

## License

See [LICENSE](LICENSE).
