# PRISIM Client Audit Portal

A multi-tenant portal where PRISIM staff audit client advertising accounts
(Meta and Google Ads) and clients see their own dashboards, audit scores and
reports.

- **PRISIM staff** (platform administrators) manage every client tenant.
- **Client users** belong to one or more tenants and only ever see their own
  tenant's data, with permissions set by their tenant role.

> **Status:** the full application is implemented: client management,
> invitations, Meta and Google Ads OAuth, daily sync, campaign analytics, the
> audit engine with a staff review workflow, PDF reports in private storage
> and client report access. The hosted database still has only migration 0001,
> which is why sign-in currently stops at "Account access unavailable"
> (`get_my_context()` is missing). Three migrations are prepared and **not
> applied**; see [docs/production-rollout.md](docs/production-rollout.md).

## What's in the app

| Area | Staff (`/admin`, aal2) | Client (`/app/:slug`) |
|---|---|---|
| Overview | Platform counters, audits awaiting review, failing connections, recent syncs | 30-day spend/conversions, daily trend, latest published audit, reports |
| Clients & team | Create/edit/suspend clients, invite members (email), roles, revoke | Owners/admins manage roles and access (invites go through PRISIM) |
| Ad accounts | Connect on a client's behalf, sync, backfill, connection health, sync history | Managers+ connect Meta/Google (read-only), choose accounts, sync now |
| Analytics | Per-client performance tab | Campaign analytics: KPIs, daily trend, spend by campaign, sortable table |
| Audits | Run the engine (18 rules, scored 0–100), review/dismiss/annotate findings, edit summary, publish, archive | Published audits only, without dismissed findings |
| Reports | Generate PDF (internal or shared), share/unshare, delete | Download shared reports via one-minute signed URLs |
| Activity | Database-written audit trail | – |

Realtime updates refresh sync status, accounts, audits and reports as they change.

## Stack

| Layer | Technology | Hosting (free tier) |
|---|---|---|
| Frontend | React, TypeScript, Vite, Tailwind CSS, shadcn/ui, React Query, React Router | Vercel |
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
│   ├── production-rollout.md  What the audit platform adds to the rollout, secrets, approvals
│   ├── edge-function-contract.md  Mandatory rules for Edge Functions
│   └── security.md           Threat model, secrets, operational rules
├── frontend/                 React + TypeScript + Vite application
│   ├── .env.example          Public frontend environment variables
│   └── src/
│       ├── lib/api/          PortalApi contract, Supabase implementation, errors
│       ├── features/         Analytics, connections, audits, reports, team panels
│       ├── pages/            Staff (admin/) and client (client/) pages, OAuth callback
│       ├── demo/             Demo mode: synthetic fixtures + in-memory API (never in production builds)
│       └── server/           Tests for the shared Edge Function modules
├── supabase/
│   ├── config.toml           Local development stack configuration
│   ├── functions/            Edge Functions: invite-tenant-member, ad-connections,
│   │                         sync-ad-data, run-audit, generate-report; _shared/ holds
│   │                         the audit engine, PDF builder and Meta/Google clients
│   ├── migrations/           Ordered SQL migrations (source of truth)
│   ├── seed.sql              Local-only demo data
│   └── tests/database/       pgTAP tests (RLS, integrity, invitations, vault)
└── package.json              Supabase CLI (dev dependency) and local scripts
```

## Run and inspect it

**Demo mode (no credentials, no backend).** Every screen works against
clearly labelled synthetic fixtures, using the real audit engine and PDF
builder. Nothing is sent to Supabase.

```bash
cd frontend
npm install
npm run dev:demo        # http://localhost:5173 - pick Staff, Client owner or Client viewer
```

Try: Staff → Audits → "Onboarding audit" → dismiss a finding → Publish →
Generate & share with client → Download (the PDF carries a SYNTHETIC
watermark). Then sign out, pick Client owner and open Reports.

**Live mode** uses the hosted project and needs the migrations applied first
(see the status note above): `npm run dev` with `frontend/.env.local`.

**Validation** (repository root, no Docker):

```bash
npm install
npm test                # secret scan, frontend typecheck, 74 Vitest tests, Deno check of all functions + invite tests
npm run sql:parse       # parses every migration, function body and pgTAP file with the PostgreSQL 17 parser
npm --prefix frontend run build:production
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
