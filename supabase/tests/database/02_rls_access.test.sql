-- =====================================================
-- 02 - Row Level Security: tenant isolation, roles, platform admins
-- Run locally with: npx supabase test db
--
-- Fixture map
--   Tenant A  a0000000-0000-4000-8000-000000000000  active
--   Tenant B  b0000000-0000-4000-8000-000000000000  active
--   Tenant S  c0000000-0000-4000-8000-000000000000  suspended
--
--   ...ad01  platform admin (PRISIM staff, no memberships)
--   ...00a1  owner of A
--   ...00a2  client of A
--   ...00b1  owner of B
--   ...00c1  client of suspended tenant S
--   ...00d1  signed-in user with no memberships
-- =====================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT no_plan();

-- -----------------------------------------------------
-- Fixtures (as postgres, bypassing RLS)
-- -----------------------------------------------------
INSERT INTO auth.users (id, email, email_confirmed_at, aud, role) VALUES
    ('00000000-0000-4000-8000-00000000ad01', 'staff@prisim.test',  NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000000a1', 'owner@a.test',       NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000000a2', 'client@a.test',      NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000000b1', 'owner@b.test',       NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000000c1', 'member@s.test',      NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000000d1', 'nobody@test.test',   NOW(), 'authenticated', 'authenticated');

INSERT INTO public.platform_admins (user_id) VALUES ('00000000-0000-4000-8000-00000000ad01');

INSERT INTO public.tenants (id, business_name, slug, status) VALUES
    ('a0000000-0000-4000-8000-000000000000', 'Tenant A', 'rls-tenant-a', 'active'),
    ('b0000000-0000-4000-8000-000000000000', 'Tenant B', 'rls-tenant-b', 'active'),
    ('c0000000-0000-4000-8000-000000000000', 'Tenant S', 'rls-tenant-s', 'suspended');

INSERT INTO public.tenant_memberships (tenant_id, user_id, role) VALUES
    ('a0000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000000a1', 'owner'),
    ('a0000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000000a2', 'client'),
    ('b0000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000000b1', 'owner'),
    ('c0000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000000c1', 'client');

INSERT INTO public.oauth_connections (id, tenant_id, provider, account_name, status) VALUES
    ('a0000000-0000-4000-8000-0000000000c0', 'a0000000-0000-4000-8000-000000000000', 'meta', 'A Meta', 'connected'),
    ('b0000000-0000-4000-8000-0000000000c0', 'b0000000-0000-4000-8000-000000000000', 'meta', 'B Meta', 'connected');

INSERT INTO public.ad_accounts (id, tenant_id, connection_id, provider, external_account_id) VALUES
    ('a0000000-0000-4000-8000-0000000000aa', 'a0000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-0000000000c0', 'meta', 'act_a'),
    ('b0000000-0000-4000-8000-0000000000aa', 'b0000000-0000-4000-8000-000000000000', 'b0000000-0000-4000-8000-0000000000c0', 'meta', 'act_b'),
    ('c0000000-0000-4000-8000-0000000000aa', 'c0000000-0000-4000-8000-000000000000', NULL,                                   'meta', 'act_s');

INSERT INTO public.campaigns (id, tenant_id, ad_account_id, external_campaign_id) VALUES
    ('a0000000-0000-4000-8000-0000000000ca', 'a0000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-0000000000aa', 'cmp_a'),
    ('b0000000-0000-4000-8000-0000000000ca', 'b0000000-0000-4000-8000-000000000000', 'b0000000-0000-4000-8000-0000000000aa', 'cmp_b');

INSERT INTO public.daily_metrics (tenant_id, ad_account_id, campaign_id, metric_date, impressions) VALUES
    ('a0000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-0000000000aa', 'a0000000-0000-4000-8000-0000000000ca', '2026-11-01', 100),
    ('b0000000-0000-4000-8000-000000000000', 'b0000000-0000-4000-8000-0000000000aa', 'b0000000-0000-4000-8000-0000000000ca', '2026-11-01', 200),
    ('c0000000-0000-4000-8000-000000000000', 'c0000000-0000-4000-8000-0000000000aa', NULL,                                   '2026-11-01', 300);

INSERT INTO public.audit_scores (tenant_id, platform, score) VALUES
    ('a0000000-0000-4000-8000-000000000000', 'meta', 70),
    ('b0000000-0000-4000-8000-000000000000', 'meta', 60);

INSERT INTO public.reports (tenant_id, report_name, status, storage_path) VALUES
    ('a0000000-0000-4000-8000-000000000000', 'A report', 'ready', 'a0000000-0000-4000-8000-000000000000/r1.pdf'),
    ('b0000000-0000-4000-8000-000000000000', 'B report', 'ready', 'b0000000-0000-4000-8000-000000000000/r1.pdf');

INSERT INTO public.sync_jobs (id, tenant_id, connection_id, provider, status, error_message, completed_at) VALUES
    ('a0000000-0000-4000-8000-00000000005a', 'a0000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-0000000000c0', 'meta', 'failed',    'internal: upstream 500 for act_a', NULL),
    ('b0000000-0000-4000-8000-00000000005a', 'b0000000-0000-4000-8000-000000000000', 'b0000000-0000-4000-8000-0000000000c0', 'meta', 'completed', NULL,                                NOW());

INSERT INTO public.sync_logs (tenant_id, job_id, level, message) VALUES
    ('a0000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-00000000005a', 'error', 'raw upstream error body'),
    ('b0000000-0000-4000-8000-000000000000', 'b0000000-0000-4000-8000-00000000005a', 'info',  'ok');

INSERT INTO public.tenant_invitations (tenant_id, email, role, token_hash) VALUES
    ('a0000000-0000-4000-8000-000000000000', 'invitee@a.test', 'client', encode(sha256('fixture-token-for-tenant-a-000000'::bytea), 'hex')),
    ('b0000000-0000-4000-8000-000000000000', 'invitee@b.test', 'client', encode(sha256('fixture-token-for-tenant-b-000000'::bytea), 'hex'));


-- =====================================================
-- CLIENT OF TENANT A
-- =====================================================
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}';

SELECT results_eq($$ SELECT id FROM public.tenants $$,
    $$ VALUES ('a0000000-0000-4000-8000-000000000000'::uuid) $$, 'client: sees only own tenant');
SELECT results_eq($$ SELECT id FROM public.ad_accounts $$,
    $$ VALUES ('a0000000-0000-4000-8000-0000000000aa'::uuid) $$, 'client: sees only own ad accounts');
SELECT results_eq($$ SELECT id FROM public.campaigns $$,
    $$ VALUES ('a0000000-0000-4000-8000-0000000000ca'::uuid) $$, 'client: sees only own campaigns');
SELECT results_eq($$ SELECT tenant_id FROM public.daily_metrics $$,
    $$ VALUES ('a0000000-0000-4000-8000-000000000000'::uuid) $$, 'client: sees only own metrics');
SELECT results_eq($$ SELECT tenant_id FROM public.audit_scores $$,
    $$ VALUES ('a0000000-0000-4000-8000-000000000000'::uuid) $$, 'client: sees only own audit scores');
SELECT results_eq($$ SELECT tenant_id FROM public.reports $$,
    $$ VALUES ('a0000000-0000-4000-8000-000000000000'::uuid) $$, 'client: sees only own reports');
SELECT results_eq($$ SELECT user_id FROM public.tenant_memberships $$,
    $$ VALUES ('00000000-0000-4000-8000-0000000000a2'::uuid) $$, 'client: sees only own membership');
SELECT results_eq($$ SELECT id FROM public.profiles $$,
    $$ VALUES ('00000000-0000-4000-8000-0000000000a2'::uuid) $$, 'client: sees only own profile');

SELECT is_empty($$ SELECT id FROM public.sync_jobs $$,          'client: cannot read sync jobs');
SELECT is_empty($$ SELECT id FROM public.sync_logs $$,          'client: cannot read sync logs');
SELECT is_empty($$ SELECT id FROM public.audit_logs $$,         'client: cannot read audit logs');
SELECT is_empty($$ SELECT id FROM public.tenant_invitations $$, 'client: cannot read invitations');
SELECT is_empty($$ SELECT id FROM public.oauth_connections $$,  'client: cannot read connections (manager+ only)');
SELECT is_empty($$ SELECT user_id FROM public.platform_admins $$, 'client: cannot list platform admins');

SELECT results_eq(
    $$ SELECT provider, last_status FROM public.get_tenant_sync_status('a0000000-0000-4000-8000-000000000000') $$,
    $$ VALUES ('meta'::text, 'failed'::text) $$,
    'client: gets sanitized sync status for own tenant');
SELECT is_empty(
    $$ SELECT * FROM public.get_tenant_sync_status('b0000000-0000-4000-8000-000000000000') $$,
    'client: gets no sync status for another tenant');

SELECT is((public.get_my_context() ->> 'is_platform_admin')::boolean, FALSE, 'client: context says not platform admin');
SELECT is(jsonb_array_length(public.get_my_context() -> 'memberships'), 1, 'client: context lists one membership');
SELECT ok(public.is_tenant_member('a0000000-0000-4000-8000-000000000000'), 'client: is_tenant_member(A) is true');
SELECT ok(NOT public.is_tenant_member('b0000000-0000-4000-8000-000000000000'), 'client: is_tenant_member(B) is false');

SELECT ok(private.can_read_tenant_object('a0000000-0000-4000-8000-000000000000/r1.pdf'), 'client: may read own tenant storage folder');
SELECT ok(NOT private.can_read_tenant_object('b0000000-0000-4000-8000-000000000000/r1.pdf'), 'client: may not read other tenant storage folder');
SELECT ok(NOT private.can_read_tenant_object('not-a-uuid/r1.pdf'), 'client: malformed storage path is denied');

-- Direct writes are denied
SELECT throws_ok($$ INSERT INTO public.tenants (business_name, slug) VALUES ('X', 'x-tenant') $$,
    '42501', NULL, 'client: cannot create tenants');
SELECT throws_ok($$ INSERT INTO public.ad_accounts (tenant_id, provider, external_account_id)
                    VALUES ('a0000000-0000-4000-8000-000000000000', 'meta', 'act_new') $$,
    '42501', NULL, 'client: cannot insert data even into own tenant');
SELECT throws_ok($$ INSERT INTO public.tenant_memberships (tenant_id, user_id, role)
                    VALUES ('b0000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000000a2', 'owner') $$,
    '42501', NULL, 'client: cannot join another tenant');
SELECT throws_ok($$ INSERT INTO public.platform_admins (user_id) VALUES ('00000000-0000-4000-8000-0000000000a2') $$,
    '42501', NULL, 'client: cannot make self platform admin');

WITH u AS (UPDATE public.tenant_memberships SET role = 'owner'
           WHERE user_id = '00000000-0000-4000-8000-0000000000a2' RETURNING 1)
SELECT is(count(*)::int, 0, 'client: cannot escalate own role') FROM u;

WITH u AS (UPDATE public.audit_scores SET score = 0 RETURNING 1)
SELECT is(count(*)::int, 0, 'client: cannot modify audit scores') FROM u;

WITH d AS (DELETE FROM public.reports RETURNING 1)
SELECT is(count(*)::int, 0, 'client: cannot delete reports') FROM d;

WITH u AS (UPDATE public.profiles SET full_name = 'Client A'
           WHERE id = '00000000-0000-4000-8000-0000000000a2' RETURNING 1)
SELECT is(count(*)::int, 1, 'client: can update own profile name') FROM u;

WITH u AS (UPDATE public.profiles SET full_name = 'Hacked'
           WHERE id = '00000000-0000-4000-8000-0000000000a1' RETURNING 1)
SELECT is(count(*)::int, 0, 'client: cannot update someone else''s profile') FROM u;

SELECT throws_ok($$ UPDATE public.profiles SET email = 'evil@x.test' WHERE id = '00000000-0000-4000-8000-0000000000a2' $$,
    '42501', NULL, 'client: cannot change profile e-mail directly');

-- Secrets
SELECT throws_ok($$ SELECT encrypted_access_token FROM public.oauth_connections $$,
    '42501', NULL, 'client: legacy token column is not selectable');
SELECT throws_ok($$ SELECT * FROM private.oauth_credentials $$,
    '42501', NULL, 'client: private credentials table is not readable');
SELECT throws_ok($$ SELECT * FROM public.get_oauth_tokens('a0000000-0000-4000-8000-0000000000c0') $$,
    '42501', NULL, 'client: cannot call get_oauth_tokens');
SELECT throws_ok($$ SELECT public.store_oauth_tokens('a0000000-0000-4000-8000-0000000000c0', 'x') $$,
    '42501', NULL, 'client: cannot call store_oauth_tokens');


-- =====================================================
-- OWNER OF TENANT A
-- =====================================================
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}';

SELECT is((SELECT count(*)::int FROM public.tenant_memberships), 2, 'owner: sees all memberships of own tenant');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.tenant_memberships WHERE tenant_id <> 'a0000000-0000-4000-8000-000000000000'),
    'owner: sees no memberships of other tenants');
SELECT results_eq($$ SELECT id FROM public.profiles ORDER BY id $$,
    $$ VALUES ('00000000-0000-4000-8000-0000000000a1'::uuid), ('00000000-0000-4000-8000-0000000000a2'::uuid) $$,
    'owner: sees profiles of own tenant members only');
SELECT results_eq($$ SELECT id FROM public.oauth_connections $$,
    $$ VALUES ('a0000000-0000-4000-8000-0000000000c0'::uuid) $$, 'owner: sees own connections only');
SELECT results_eq($$ SELECT email FROM public.tenant_invitations $$,
    $$ VALUES ('invitee@a.test'::text) $$, 'owner: sees own tenant invitations only');
SELECT throws_ok($$ SELECT token_hash FROM public.tenant_invitations $$,
    '42501', NULL, 'owner: invitation token hash is not selectable');
SELECT ok((SELECT count(*) FROM public.audit_logs) > 0, 'owner: sees own tenant audit log');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE tenant_id IS DISTINCT FROM 'a0000000-0000-4000-8000-000000000000'),
    'owner: sees no audit entries of other tenants or the platform');
SELECT is_empty($$ SELECT id FROM public.sync_jobs $$, 'owner: still cannot read raw sync jobs');
SELECT throws_ok($$ INSERT INTO public.tenant_memberships (tenant_id, user_id, role)
                    VALUES ('a0000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000000d1', 'client') $$,
    '42501', NULL, 'owner: membership changes must go through the member RPCs');


-- =====================================================
-- MEMBER OF SUSPENDED TENANT S
-- =====================================================
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000000c1","role":"authenticated"}';

SELECT is_empty($$ SELECT id FROM public.tenants $$,          'suspended: tenant row hidden');
SELECT is_empty($$ SELECT id FROM public.ad_accounts $$,      'suspended: ad accounts hidden');
SELECT is_empty($$ SELECT id FROM public.daily_metrics $$,    'suspended: metrics hidden');
SELECT ok(NOT public.is_tenant_member('c0000000-0000-4000-8000-000000000000'), 'suspended: is_tenant_member is false');
SELECT ok(NOT private.can_read_tenant_object('c0000000-0000-4000-8000-000000000000/r1.pdf'), 'suspended: storage folder denied');
SELECT is(public.get_my_context() -> 'memberships' -> 0 ->> 'tenant_status', 'suspended',
    'suspended: context reports tenant status so the UI can explain');


-- =====================================================
-- SIGNED-IN USER WITHOUT MEMBERSHIPS
-- =====================================================
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000000d1","role":"authenticated"}';

SELECT is_empty($$ SELECT id FROM public.tenants $$,            'no membership: no tenants');
SELECT is_empty($$ SELECT id FROM public.daily_metrics $$,      'no membership: no metrics');
SELECT is_empty($$ SELECT id FROM public.tenant_memberships $$, 'no membership: no memberships');
SELECT is(jsonb_array_length(public.get_my_context() -> 'memberships'), 0, 'no membership: empty context');


-- =====================================================
-- ANONYMOUS (not signed in)
-- =====================================================
RESET ROLE;
SET LOCAL ROLE anon;
SET LOCAL request.jwt.claims TO '{"role":"anon"}';

SELECT throws_ok($$ SELECT id FROM public.tenants $$,       '42501', NULL, 'anon: tenants not readable');
SELECT throws_ok($$ SELECT id FROM public.daily_metrics $$, '42501', NULL, 'anon: metrics not readable');
SELECT throws_ok($$ SELECT public.get_my_context() $$,      '42501', NULL, 'anon: cannot call get_my_context');
SELECT throws_ok($$ SELECT public.accept_invitation('fixture-token-for-tenant-a-000000') $$,
    '42501', NULL, 'anon: cannot accept invitations');


-- =====================================================
-- PLATFORM ADMINISTRATOR WITHOUT MFA (aal1)
-- =====================================================
RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-00000000ad01","role":"authenticated","aal":"aal1"}';

SELECT ok(NOT private.is_platform_admin(), 'admin aal1: has no platform-admin privileges');
SELECT is((public.get_my_context() ->> 'is_platform_admin')::boolean, FALSE, 'admin aal1: context says not platform admin');
SELECT is((public.get_my_context() ->> 'platform_admin_mfa_required')::boolean, TRUE, 'admin aal1: context asks for MFA step-up');
SELECT is_empty($$ SELECT id FROM public.tenants $$,       'admin aal1: sees no tenants');
SELECT is_empty($$ SELECT id FROM public.daily_metrics $$, 'admin aal1: sees no metrics');
SELECT is_empty($$ SELECT id FROM public.sync_jobs $$,     'admin aal1: sees no sync jobs');
SELECT is_empty($$ SELECT id FROM public.audit_logs $$,    'admin aal1: sees no audit logs');
SELECT ok(NOT private.can_read_tenant_object('b0000000-0000-4000-8000-000000000000/r1.pdf'), 'admin aal1: no storage access');
SELECT throws_ok($$ INSERT INTO public.ad_accounts (tenant_id, provider, external_account_id)
                    VALUES ('b0000000-0000-4000-8000-000000000000', 'google', 'aal1-attempt') $$,
    '42501', NULL, 'admin aal1: cannot write tenant data');
SELECT throws_ok($$ SELECT public.begin_privileged_action('a0000000-0000-4000-8000-000000000000', 'invitation.create') $$,
    '42501', NULL, 'admin aal1: cannot authorize invitation creation');
SELECT results_eq($$ SELECT user_id FROM public.platform_admins $$,
    $$ VALUES ('00000000-0000-4000-8000-00000000ad01'::uuid) $$, 'admin aal1: may still read own platform_admins row');

-- No aal claim at all is treated like aal1.
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-00000000ad01","role":"authenticated"}';
SELECT ok(NOT private.is_platform_admin(), 'admin without aal claim: no platform-admin privileges');

-- A non-admin with an aal2 session gets nothing extra.
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}';
SELECT ok(NOT private.is_platform_admin(), 'client aal2: still not a platform admin');
SELECT is((public.get_my_context() ->> 'platform_admin_mfa_required')::boolean, FALSE, 'client: no MFA step-up prompt');


-- =====================================================
-- PLATFORM ADMINISTRATOR WITH MFA (aal2)
-- =====================================================
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-00000000ad01","role":"authenticated","aal":"aal2"}';

SELECT ok(private.is_platform_admin(), 'admin aal2: has platform-admin privileges');
SELECT is((public.get_my_context() ->> 'is_platform_admin')::boolean, TRUE, 'admin: context says platform admin');
SELECT is((public.get_my_context() ->> 'platform_admin_mfa_required')::boolean, FALSE, 'admin aal2: no MFA prompt');
SELECT is((SELECT count(*)::int FROM public.tenants
           WHERE id IN ('a0000000-0000-4000-8000-000000000000', 'b0000000-0000-4000-8000-000000000000', 'c0000000-0000-4000-8000-000000000000')),
    3, 'admin: sees all tenants including suspended');
SELECT is((SELECT count(*)::int FROM public.daily_metrics
           WHERE tenant_id IN ('a0000000-0000-4000-8000-000000000000', 'b0000000-0000-4000-8000-000000000000', 'c0000000-0000-4000-8000-000000000000')),
    3, 'admin: sees metrics of every tenant');
SELECT is((SELECT error_message FROM public.sync_jobs WHERE id = 'a0000000-0000-4000-8000-00000000005a'),
    'internal: upstream 500 for act_a', 'admin: can read internal sync errors');
SELECT is((SELECT count(*)::int FROM public.sync_logs
           WHERE tenant_id IN ('a0000000-0000-4000-8000-000000000000', 'b0000000-0000-4000-8000-000000000000')),
    2, 'admin: can read sync logs');
SELECT ok((SELECT count(*) FROM public.profiles
           WHERE id IN ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1')) = 2,
    'admin: can read profiles across tenants');
SELECT ok(private.can_read_tenant_object('b0000000-0000-4000-8000-000000000000/r1.pdf'), 'admin: may read any tenant storage folder');

SELECT lives_ok($$ INSERT INTO public.ad_accounts (tenant_id, provider, external_account_id)
                   VALUES ('b0000000-0000-4000-8000-000000000000', 'google', '999-999-9999') $$,
    'admin: can create ad accounts for any tenant');
SELECT lives_ok($$ UPDATE public.tenants SET status = 'suspended' WHERE id = 'b0000000-0000-4000-8000-000000000000' $$,
    'admin: can suspend a tenant');
SELECT lives_ok($$ SELECT public.revoke_invitation(id) FROM public.tenant_invitations
                   WHERE tenant_id = 'b0000000-0000-4000-8000-000000000000' $$,
    'admin: can revoke invitations through the RPC');
SELECT throws_ok($$ UPDATE public.tenant_invitations SET status = 'pending'
                    WHERE tenant_id = 'b0000000-0000-4000-8000-000000000000' $$,
    '42501', NULL, 'admin: cannot edit invitations directly');

SELECT throws_ok($$ DELETE FROM public.tenants WHERE id = 'b0000000-0000-4000-8000-000000000000' $$,
    '42501', NULL, 'admin: cannot hard-delete tenants through the API');
SELECT throws_ok($$ INSERT INTO public.platform_admins (user_id) VALUES ('00000000-0000-4000-8000-0000000000d1') $$,
    '42501', NULL, 'admin: cannot grant platform admin through the API');
SELECT throws_ok($$ UPDATE public.audit_logs SET action = 'tampered' $$,
    '42501', NULL, 'admin: cannot tamper with the audit log');
SELECT throws_ok($$ SELECT encrypted_access_token FROM public.oauth_connections $$,
    '42501', NULL, 'admin: legacy token column is not selectable');
SELECT throws_ok($$ SELECT * FROM public.get_oauth_tokens('a0000000-0000-4000-8000-0000000000c0') $$,
    '42501', NULL, 'admin: cannot read OAuth tokens from the browser');

-- Owner of B lost access once B was suspended above.
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
SELECT is_empty($$ SELECT id FROM public.daily_metrics $$, 'suspension takes effect immediately for tenant users');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
