-- =====================================================
-- 04 - Role boundaries, membership status, profile visibility,
--      member-management RPCs and audit attribution
-- Run locally with: npx supabase test db
--
-- Fixture map
--   Tenant A  a4000000-...  active
--   Tenant B  b4000000-...  active
--   Tenant S  c4000000-...  suspended
--
--   ...04a1 owner of A          ...04a2 admin of A
--   ...04a3 manager of A        ...04a4 viewer of A
--   ...04a5 client of A, INACTIVE membership
--   ...04a6 client of A, INVITED membership
--   ...04c1 client of A and client of B
--   ...04b1 client of B only
--   ...04e1 client of suspended S
--   ...04ad platform admin
-- =====================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT no_plan();

INSERT INTO auth.users (id, email, email_confirmed_at, aud, role) VALUES
    ('00000000-0000-4000-8000-0000000004a1', 'owner@a4.test',    NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000004a2', 'admin@a4.test',    NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000004a3', 'manager@a4.test',  NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000004a4', 'viewer@a4.test',   NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000004a5', 'inactive@a4.test', NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000004a6', 'invited@a4.test',  NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000004c1', 'both@ab4.test',    NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000004b1', 'client@b4.test',   NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000004e1', 'client@s4.test',   NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000004ad', 'staff@p4.test',    NOW(), 'authenticated', 'authenticated');

INSERT INTO public.platform_admins (user_id) VALUES ('00000000-0000-4000-8000-0000000004ad');

INSERT INTO public.tenants (id, business_name, slug, status) VALUES
    ('a4000000-0000-4000-8000-000000000000', 'Roles A', 'roles-a', 'active'),
    ('b4000000-0000-4000-8000-000000000000', 'Roles B', 'roles-b', 'active'),
    ('c4000000-0000-4000-8000-000000000000', 'Roles S', 'roles-s', 'suspended');

INSERT INTO public.tenant_memberships (tenant_id, user_id, role, status) VALUES
    ('a4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004a1', 'owner',   'active'),
    ('a4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004a2', 'admin',   'active'),
    ('a4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004a3', 'manager', 'active'),
    ('a4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004a4', 'viewer',  'active'),
    ('a4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004a5', 'client',  'inactive'),
    ('a4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004a6', 'client',  'invited'),
    ('a4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004c1', 'client',  'active'),
    ('b4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004c1', 'client',  'active'),
    ('b4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004b1', 'client',  'active'),
    ('c4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004e1', 'client',  'active');

INSERT INTO public.oauth_connections (id, tenant_id, provider, status) VALUES
    ('a4000000-0000-4000-8000-0000000000c0', 'a4000000-0000-4000-8000-000000000000', 'meta', 'connected'),
    ('b4000000-0000-4000-8000-0000000000c0', 'b4000000-0000-4000-8000-000000000000', 'meta', 'connected');

INSERT INTO public.ad_accounts (id, tenant_id, provider, external_account_id) VALUES
    ('a4000000-0000-4000-8000-0000000000aa', 'a4000000-0000-4000-8000-000000000000', 'meta', 'act_a4'),
    ('b4000000-0000-4000-8000-0000000000aa', 'b4000000-0000-4000-8000-000000000000', 'meta', 'act_b4');

INSERT INTO public.daily_metrics (tenant_id, ad_account_id, metric_date, impressions, source_payload) VALUES
    ('a4000000-0000-4000-8000-000000000000', 'a4000000-0000-4000-8000-0000000000aa', '2026-11-01', 10, '{"raw":"provider internals"}');

INSERT INTO public.sync_jobs (tenant_id, provider, status, completed_at) VALUES
    ('c4000000-0000-4000-8000-000000000000', 'meta', 'completed', NOW());

INSERT INTO public.tenant_invitations (tenant_id, email, role, token_hash) VALUES
    ('a4000000-0000-4000-8000-000000000000', 'pending@a4.test', 'client', encode(sha256('roles-fixture-token-a4-0000000000000'::bytea), 'hex'));

SET LOCAL ROLE authenticated;


-- =====================================================
-- 1. MANAGER of A
-- =====================================================
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000004a3","role":"authenticated"}';

SELECT results_eq($$ SELECT id FROM public.oauth_connections $$,
    $$ VALUES ('a4000000-0000-4000-8000-0000000000c0'::uuid) $$, 'manager: sees own tenant connections');
SELECT results_eq($$ SELECT user_id FROM public.tenant_memberships $$,
    $$ VALUES ('00000000-0000-4000-8000-0000000004a3'::uuid) $$, 'manager: sees only own membership (admin+ sees all)');
SELECT is_empty($$ SELECT id FROM public.tenant_invitations $$, 'manager: cannot read invitations');
SELECT is_empty($$ SELECT id FROM public.audit_logs $$,         'manager: cannot read audit logs');
SELECT throws_ok($$ SELECT public.begin_privileged_action('a4000000-0000-4000-8000-000000000000', 'invitation.create') $$,
    '42501', NULL, 'manager: cannot authorize invitation creation');
SELECT throws_ok($$ SELECT public.change_member_role('a4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004a4', 'client') $$,
    '42501', NULL, 'manager: cannot change roles');

-- 8. Profile visibility across tenants
SELECT ok(EXISTS (SELECT 1 FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000004c1'),
    'manager: sees profile of a member shared with another tenant');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000004b1'),
    'manager: cannot see profile of a user who belongs only to another tenant');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.profiles WHERE id IN ('00000000-0000-4000-8000-0000000004e1', '00000000-0000-4000-8000-0000000004ad')),
    'manager: cannot see suspended-tenant users or platform staff');

-- source_payload is never readable through the API
SELECT throws_ok($$ SELECT source_payload FROM public.daily_metrics $$,
    '42501', NULL, 'manager: daily_metrics.source_payload is not selectable');
SELECT throws_ok($$ SELECT * FROM public.daily_metrics $$,
    '42501', NULL, 'manager: select * on daily_metrics is rejected');
SELECT results_eq($$ SELECT impressions FROM public.daily_metrics $$,
    $$ VALUES (10::bigint) $$, 'manager: explicit metric columns are readable');


-- =====================================================
-- 1. VIEWER of A
-- =====================================================
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000004a4","role":"authenticated"}';

SELECT results_eq($$ SELECT id FROM public.ad_accounts $$,
    $$ VALUES ('a4000000-0000-4000-8000-0000000000aa'::uuid) $$, 'viewer: reads own tenant data');
SELECT is_empty($$ SELECT id FROM public.oauth_connections $$, 'viewer: cannot read connections');
SELECT results_eq($$ SELECT id FROM public.profiles $$,
    $$ VALUES ('00000000-0000-4000-8000-0000000004a4'::uuid) $$, 'viewer: sees only own profile');
SELECT is((SELECT count(*)::int FROM public.tenant_memberships), 1, 'viewer: sees only own membership');
SELECT throws_ok($$ SELECT public.deactivate_member('a4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004c1') $$,
    '42501', NULL, 'viewer: cannot deactivate members');


-- =====================================================
-- 1. ADMIN of A
-- =====================================================
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000004a2","role":"authenticated"}';

SELECT is((SELECT count(*)::int FROM public.tenant_memberships), 7, 'admin: sees every membership of own tenant');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.tenant_memberships WHERE tenant_id <> 'a4000000-0000-4000-8000-000000000000'),
    'admin: sees no memberships of other tenants');
SELECT results_eq($$ SELECT email FROM public.tenant_invitations $$,
    $$ VALUES ('pending@a4.test'::text) $$, 'admin: reads own tenant invitations');
SELECT ok((SELECT count(*) FROM public.audit_logs) > 0, 'admin: reads own tenant audit log');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE tenant_id IS DISTINCT FROM 'a4000000-0000-4000-8000-000000000000'),
    'admin: sees no audit entries of other tenants or the platform');

SELECT throws_ok($$ SELECT public.begin_privileged_action('a4000000-0000-4000-8000-000000000000', 'invitation.create') $$,
    '42501', NULL, 'tenant admin: cannot authorize platform invitation creation');

SELECT lives_ok($$ SELECT public.change_member_role('a4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004a4', 'client') $$,
    'admin: can change a viewer to client');
SELECT throws_ok($$ SELECT public.change_member_role('a4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004a3', 'admin') $$,
    '42501', NULL, 'admin: cannot promote to admin');
SELECT throws_ok($$ SELECT public.change_member_role('a4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004a1', 'client') $$,
    '42501', NULL, 'admin: cannot demote the owner');
SELECT throws_ok($$ SELECT public.deactivate_member('a4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004a1') $$,
    '42501', NULL, 'admin: cannot deactivate the owner');
SELECT throws_ok($$ SELECT public.change_member_role('a4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004a2', 'owner') $$,
    '42501', NULL, 'admin: cannot promote self');

-- H2: tenant writes through RPCs are attributed to the signed-in actor.
RESET ROLE;
SELECT results_eq(
    $$ SELECT user_id, actor_role FROM public.audit_logs
       WHERE action = 'tenant_memberships.update'
         AND entity_type = 'tenant_memberships'
         AND details -> 'new' ->> 'user_id' = '00000000-0000-4000-8000-0000000004a4' $$,
    $$ VALUES ('00000000-0000-4000-8000-0000000004a2'::uuid, 'authenticated'::text) $$,
    'audit: role change attributed to the admin who made it');
SET LOCAL ROLE authenticated;


-- =====================================================
-- OWNER of A: last-owner protection
-- =====================================================
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000004a1","role":"authenticated"}';

SELECT throws_ok($$ SELECT public.change_member_role('a4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004a1', 'admin') $$,
    '23514', NULL, 'owner: last owner cannot demote self');
SELECT throws_ok($$ SELECT public.deactivate_member('a4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004a1') $$,
    '23514', NULL, 'owner: last owner cannot deactivate self');
SELECT lives_ok($$ SELECT public.change_member_role('a4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004a2', 'owner') $$,
    'owner: can promote an admin to owner');
SELECT lives_ok($$ SELECT public.change_member_role('a4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004a1', 'admin') $$,
    'owner: can step down once another owner exists');
SELECT throws_ok($$ SELECT public.change_member_role('a4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004a2', 'client') $$,
    '42501', NULL, 'former owner (now admin): cannot demote the new owner');


-- =====================================================
-- 2. INACTIVE and INVITED memberships
-- =====================================================
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000004a5","role":"authenticated"}';
SELECT is_empty($$ SELECT id FROM public.tenants $$,          'inactive: no tenants');
SELECT is_empty($$ SELECT id FROM public.ad_accounts $$,      'inactive: no ad accounts');
SELECT is_empty($$ SELECT tenant_id FROM public.daily_metrics $$, 'inactive: no metrics');
SELECT ok(NOT public.is_tenant_member('a4000000-0000-4000-8000-000000000000'), 'inactive: is_tenant_member is false');
SELECT ok(NOT private.can_read_tenant_object('a4000000-0000-4000-8000-000000000000/r.pdf'), 'inactive: storage denied');
SELECT is(jsonb_array_length(public.get_my_context() -> 'memberships'), 0, 'inactive: context lists no memberships');

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000004a6","role":"authenticated"}';
SELECT is_empty($$ SELECT id FROM public.tenants $$,          'invited: no tenants');
SELECT is_empty($$ SELECT id FROM public.ad_accounts $$,      'invited: no ad accounts');
SELECT ok(NOT public.is_tenant_member('a4000000-0000-4000-8000-000000000000'), 'invited: is_tenant_member is false');
SELECT ok(NOT private.can_read_tenant_object('a4000000-0000-4000-8000-000000000000/r.pdf'), 'invited: storage denied');


-- =====================================================
-- Multi-tenant client sees exactly its two tenants
-- =====================================================
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000004c1","role":"authenticated"}';
SELECT results_eq($$ SELECT id FROM public.tenants ORDER BY id $$,
    $$ VALUES ('a4000000-0000-4000-8000-000000000000'::uuid), ('b4000000-0000-4000-8000-000000000000'::uuid) $$,
    'multi-tenant client: sees both of its tenants and nothing else');


-- =====================================================
-- 9. AUTHENTICATED ROLE WITHOUT A sub CLAIM
-- =====================================================
SET LOCAL request.jwt.claims TO '{"role":"authenticated"}';
SELECT is_empty($$ SELECT id FROM public.tenants $$,            'no sub: no tenants');
SELECT is_empty($$ SELECT id FROM public.profiles $$,           'no sub: no profiles');
SELECT is_empty($$ SELECT id FROM public.tenant_memberships $$, 'no sub: no memberships');
SELECT is_empty($$ SELECT id FROM public.audit_logs $$,         'no sub: no audit logs');
SELECT ok(NOT private.is_platform_admin(), 'no sub: not a platform admin');
SELECT ok((public.get_my_context() -> 'user_id') = 'null'::jsonb, 'no sub: context has no user');
SELECT is(jsonb_array_length(public.get_my_context() -> 'memberships'), 0, 'no sub: context has no memberships');
SELECT throws_ok($$ SELECT public.accept_invitation('roles-fixture-token-a4-0000000000000') $$,
    '42501', NULL, 'no sub: cannot accept invitations');
SELECT throws_ok($$ SELECT public.begin_privileged_action('a4000000-0000-4000-8000-000000000000', 'invitation.create') $$,
    '42501', NULL, 'no sub: cannot authorize invitation creation');

-- Same with aal2 but no sub: MFA alone grants nothing.
SET LOCAL request.jwt.claims TO '{"role":"authenticated","aal":"aal2"}';
SELECT ok(NOT private.is_platform_admin(), 'no sub + aal2: not a platform admin');


-- =====================================================
-- 10. SUSPENDED TENANT SYNC STATUS
-- =====================================================
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000004e1","role":"authenticated"}';
SELECT is_empty($$ SELECT * FROM public.get_tenant_sync_status('c4000000-0000-4000-8000-000000000000') $$,
    'suspended: member gets no sync status');

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000004ad","role":"authenticated","aal":"aal2"}';
SELECT results_eq($$ SELECT provider, last_status FROM public.get_tenant_sync_status('c4000000-0000-4000-8000-000000000000') $$,
    $$ VALUES ('meta'::text, 'completed'::text) $$, 'suspended: platform admin still sees sync status');
SELECT lives_ok($$ SELECT public.deactivate_member('c4000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000004e1') $$,
    'platform admin: can manage members of any tenant');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
