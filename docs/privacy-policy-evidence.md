# Privacy policy: evidence matrix

Public page: <https://audit.prisim.co.in/privacy-policy>
(source `frontend/src/pages/PrivacyPolicyPage.tsx`, static copy built by
`frontend/scripts/prerender-privacy-policy.mjs`).

Each statement in the policy is backed by implementation evidence (**Code**),
a confirmed PRISIM detail (**Confirmed**), the law (**Law**), or is an
organisational commitment that PRISIM management must confirm (**Needs
confirmation**). Update this file whenever the policy or the behaviour changes.

| # | Section | Statement | Evidence | Type |
|---|---|---|---|---|
| 1 | Introduction, Contact | Entity "PRISIM", email info@prisim.co.in, Mathikere address | Supplied by PRISIM, 17 Nov 2026 | Confirmed |
| 2 | Scope | No public sign-up; staff create accounts | `auth.enable_signup = false` (live config); `manage-tenant-user` Edge Function is staff-only | Code |
| 4 | Roles | Fiduciary for accounts/contacts/security records; may be processor for client advertising data | Depends on client contracts | Needs confirmation (legal) |
| 5 | Categories | Name, email, avatar, membership, role (owner/viewer), status | `profiles`, `tenant_memberships`; roles limited to owner/viewer by `manage-tenant-user` | Code |
| 5 | Categories | Client business name, industry, website, contact name, contact email | `ClientsPage.tsx` new-client form; `tenants` | Code |
| 5 | Categories | Ad account, campaign, daily metric fields; Meta client business ID | `providers/meta.ts`, `providers/google.ts`, `ad_accounts.metadata` | Code |
| 5 | Categories | Passwords handled by auth provider; staff TOTP | Supabase Auth; `private.is_platform_admin()` requires aal2 | Code |
| 8 | Grounds | Consent and certain legitimate uses (DPDP Act ss. 6, 7) | DPDP Act 2023 | Law |
| 9 | Notice and consent | No in-app consent screen; platform consent screens for ad access | No consent UI exists; OAuth via Meta/Google dialogs | Code (gap disclosed) |
| 10 | Consent records | Connect/disconnect recorded with staff actor, tenant, time and granted scopes | `private.privileged_actions` + `audit_row_change` triggers on `oauth_connections`, `privileged_actions`; `oauth_connections.scopes` | Code |
| 10 | Consent records | Account creation and access changes logged | `audit_row_change` on `profiles`, `tenant_memberships` | Code |
| 12 | Meta | Requests ads_read, business_management, pages_show_list, pages_read_engagement | Meta Business Login configuration (per PRISIM) | Confirmed |
| 12 | Meta | Reads only explicitly granted ad accounts; no Page data; no writes | `meta.ts` `evaluateDebugToken` / `grantedAccounts`; no Page or write endpoints in code | Code |
| 13 | Google | Read-only use; Limited Use statement | `google.ts` reads only; Limited Use is a commitment | Code + Needs confirmation |
| 14 | Supabase/Vercel | Supabase project in Mumbai (ap-south-1); Vercel hosting | Project `svqzxrkkakfiigrsndzn` region ap-south-1; Vercel project `prisim-client-audit` | Code/config |
| 15 | Other providers | No third-party analytics or advertising services | No such scripts in `index.html` or bundle | Code |
| 16 | Transfers | Vercel global network, Meta/Google international | Provider architecture | Config |
| 17 | Security | Tenant separation by database access rules | RLS on all 16 public tables (verified 16/16) | Code |
| 17 | Security | Credentials in encrypted secrets store, never sent to browser | Supabase Vault via `store_oauth_tokens`; handler returns no tokens (tests in `function-handlers.test.ts`) | Code |
| 17 | Security | HTTPS; private report storage; expiring links | HSTS header (`vercel.json`); private `reports` bucket; `createSignedUrl(..., 60)` | Code |
| 17 | Security | Activity log cannot be edited or deleted | `audit_logs_append_only` / `audit_logs_no_truncate` triggers | Code |
| 18 | Staff access | Admin actions staff-only with two-step verification and attribution | `is_platform_admin()` (aal2), migration `20261113120000`, privileged actions | Code |
| 19 | Retention | Raw payload cleared ~14 days; sync logs ~90 days; expired privileged actions ~30 days | `private.prune_operational_data()` scheduled daily (`prisim-prune-operational-data`, active) | Code |
| 19 | Retention | Raw payloads are not currently written by sync | `ingest_ad_account_data` does not set `source_payload` | Code |
| 19 | Retention | Ad data, audits, reports: no automatic expiry | No pruning of these tables | Code |
| 19 | Retention | Audit log: no automatic expiry | Append-only, no purge job | Code |
| 19 | Retention | Credentials deleted on disconnect; connection kept as revoked | `delete_oauth_tokens` + `purge_oauth_secrets` trigger | Code |
| 19 | Retention | Privacy correspondence kept as long as needed | Organisational | Needs confirmation |
| 20 | Deletion | Staff can delete audits and reports (PDF file + record) | `supabase-api.ts` `deleteAuditRun`, `deleteReport` | Code |
| 20, 33 | Deletion/offboarding | Organisation/user deletion on request, not self-service, not automatic | No deletion UI; manual PRISIM process | Needs confirmation (process) |
| 21 | Backups | Provider backups/logs; no fixed period stated | Supabase plan backups not recorded (`docs/deployment-checklist.md` B2) | Gap disclosed |
| 22 | Breaches | Contain, assess, notify as required by DPDP Act/Rules | DPDP Rules 2025 rule 7; no internal incident runbook documented | Law + Needs confirmation |
| 23 | Rights | Access, correction/completion/updating, erasure, withdrawal, grievance, nomination | DPDP Act ss. 6(4), 11-14; duties s. 15 | Law |
| 23 | Rights | Phased commencement | DPDP Rules 2025 (G.S.R. 846(E), 13 Nov 2025); most duties from about May 2027 | Law (verify dates) |
| 24-28 | Requests | No self-service rights centre; email route; identifier = registered email | No rights centre implemented | Gap disclosed |
| 26 | Grievances | Max 90 days once rule in force; exhaust before Board | Rules r. 14(3); Act s. 13(3) | Law |
| 27 | Nomination | One or more nominees; via email | Act s. 14; Rules r. 14(4) | Law |
| 29 | Children | Not intended for under-18s | Business-only service | Confirmed by design |
| 30 | Sharing | No sale; providers, platforms, client users, legal | Code has no other recipients | Code + Needs confirmation |
| 31 | Browser storage | Session in localStorage; OAuth return path in sessionStorage; no analytics cookies | `lib/supabase.ts` (`persistSession`), `ConnectionsPanel.tsx` | Code |
| 32 | Suspension | Suspended/inactive tenants keep data, deny client access; removing access keeps account | `ClientAccessGate`; RLS requires active tenant; `deactivate_member` | Code |

## Open items for PRISIM management and counsel

1. Review of the full policy by qualified Indian privacy counsel (not done).
2. Fiduciary/processor position and client contract terms.
3. Whether a designated contact person or grievance officer must be named
   (DPDP Act s. 8(9); the policy uses info@prisim.co.in and names no person).
4. Commitments: Google Limited Use, no sale, request handling, breach
   handling, offboarding deletion process, correspondence retention.
5. Backup retention of the Supabase plan.
6. Audit log retention period (currently none).
7. Whether to keep `pages_show_list` / `pages_read_engagement` in the Meta
   configuration while unused.
8. Gaps: no self-service Privacy & Data Rights Centre, no in-app consent
   capture or consent records, no self-service deletion.
