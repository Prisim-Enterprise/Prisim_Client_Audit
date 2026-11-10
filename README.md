# PRISIM Client Audit Portal

A multi-tenant portal where PRISIM staff audit client advertising accounts
(Meta and Google Ads) and clients see their own dashboards, audit scores and
reports.

- **PRISIM staff** (platform administrators) manage every client tenant.
- **Client users** belong to one or more tenants and only ever see their own
  tenant's data, with permissions set by their tenant role.

> **Status:** frontend authentication foundation and local remediation for
> migration `20261105120000_security_hardening.sql` are present. Migration 0002
> is pending in production and remains **NO-GO** pending local database tests
> and final review.

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
│   ├── deployment-checklist.md  Authoritative hosted deployment and go-live procedure
│   ├── edge-function-contract.md  Mandatory rules for Edge Functions
│   └── security.md           Threat model, secrets, operational rules
├── frontend/                 React + TypeScript + Vite application
│   ├── .env.example          Public frontend environment variables
│   └── src/                  Authentication, routes, layouts and shared UI
├── supabase/
│   ├── config.toml           Local development stack configuration
│   ├── migrations/           Ordered SQL migrations (source of truth)
│   ├── seed.sql              Local-only demo data
│   └── tests/database/       pgTAP tests (RLS, integrity, invitations, vault)
└── package.json              Supabase CLI (dev dependency) and local scripts
```

## Frontend development

- Node.js 20+ (22 recommended)
- A publishable (or legacy anon) key for the PRISIM production Supabase project
- Docker and the Supabase CLI are **not required** for frontend development

Local Vite and production frontend builds use the existing production
Supabase project. Local development must use an authorized test account; do
not exercise writes against real client accounts.

```bash
cd frontend
npm install
Copy-Item .env.example .env.local  # PowerShell; set the public key in this ignored file
npm run dev
npm run build
npm run build:production  # production build; explicit mode and production project only
npm run typecheck
npm run test
```

`npm run dev` starts the Vite frontend and requires the production URL and
public key in ignored `frontend/.env.local`.

## Optional local database and migration validation

Docker Desktop is needed only for local database tests. Migration reset is
gated until migration 0002 is approved for local testing:

```bash
npm install                 # at repository root; installs the Supabase CLI
npm run db:start            # local Supabase in Docker
npm run db:local:verify     # reset without seed, lint, and run pgTAP; requires owner approval env gate
npm run db:stop
```

The local API, Studio and mail catcher are available at
`http://127.0.0.1:54321`, `http://127.0.0.1:54323` and
`http://127.0.0.1:54324` after `db:start`. Local signups are disabled; use
Studio and the local seed instructions when a local-stack test is required.

The frontend does not implement self-registration. Staff routes require the
database-reported platform-admin state and a TOTP-verified (`aal2`) session.
Client routes require a membership returned by `get_my_context()`; PostgreSQL
RLS remains the authorization boundary. Migration
`20261105120000_security_hardening.sql` must be applied for the frontend
context and MFA-gated admin behavior to work. The migration is not applied by
frontend startup or build.

## Database change workflow

1. Never edit a migration that has been applied to the hosted project
   (`202611050001_initial_schema.sql` is applied and frozen).
2. Add a new file `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`.
3. Validate with the database tests against the local stack; Docker is needed
   for that validation. Do not use database tests as routine frontend tests.
4. Get the migration reviewed and explicit approval for hosted application.
5. An authorized maintainer applies it to the hosted project by following
   [docs/deployment-checklist.md](docs/deployment-checklist.md).

Hosted production operations, including applying migrations, require explicit
authorization. Do not use database commands against production except for
explicitly approved read-only checks or an approved migration deployment.

## Security essentials

- Only **public** keys go in the frontend (`VITE_*`). Service-role keys,
  database passwords and OAuth client secrets live only in Supabase Edge
  Function secrets.
- Tenant isolation is enforced by PostgreSQL Row Level Security, not by the
  UI.
- Full details: [docs/security.md](docs/security.md).

## License

See [LICENSE](LICENSE).
