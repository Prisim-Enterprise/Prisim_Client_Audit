-- =====================================================
-- 08 - Last active owner protection (every role, every path)
-- Run locally with: npx supabase test db
--
-- Fixture map
--   Tenant A  a8...  one active owner (...08a1), admin (...08a2), client (...08a3)
--   Tenant B  b8...  two active owners (...08b1, ...08b2)
--   Tenant C  c8...  active owner (...08c1) + INACTIVE owner (...08c2)
--   Tenant D  d8...  sole owner (...08d1), used for auth-user deletion
--   Tenant E  e8...  sole owner (...08e1), used for tenant deletion
--   ...08ad  platform admin (aal2)
-- =====================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT no_plan();

INSERT INTO auth.users (id, email, email_confirmed_at, aud, role) VALUES
    ('00000000-0000-4000-8000-0000000008a1', 'owner@a8.test',  NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000008a2', 'admin@a8.test',  NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000008a3', 'client@a8.test', NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000008b1', 'owner1@b8.test', NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000008b2', 'owner2@b8.test', NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000008c1', 'owner@c8.test',  NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000008c2', 'former@c8.test', NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000008d1', 'owner@d8.test',  NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000008e1', 'owner@e8.test',  NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000008ad', 'staff@p8.test',  NOW(), 'authenticated', 'authenticated');
INSERT INTO public.platform_admins (user_id) VALUES ('00000000-0000-4000-8000-0000000008ad');

INSERT INTO public.tenants (id, business_name, slug) VALUES
    ('a8000000-0000-4000-8000-000000000000', 'Owner A', 'owner-a'),
    ('b8000000-0000-4000-8000-000000000000', 'Owner B', 'owner-b'),
    ('c8000000-0000-4000-8000-000000000000', 'Owner C', 'owner-c'),
    ('d8000000-0000-4000-8000-000000000000', 'Owner D', 'owner-d'),
    ('e8000000-0000-4000-8000-000000000000', 'Owner E', 'owner-e');

INSERT INTO public.tenant_memberships (tenant_id, user_id, role, status) VALUES
    ('a8000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000008a1', 'owner',  'active'),
    ('a8000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000008a2', 'admin',  'active'),
    ('a8000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000008a3', 'client', 'active'),
    ('b8000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000008b1', 'owner',  'active'),
    ('b8000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000008b2', 'owner',  'active'),
    ('c8000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000008c1', 'owner',  'active'),
    ('c8000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000008c2', 'owner',  'inactive'),
    ('d8000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000008d1', 'owner',  'active'),
    ('e8000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000008e1', 'owner',  'active');


-- =====================================================
-- Platform admin (aal2), direct table writes
-- =====================================================
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000008ad","role":"authenticated","aal":"aal2"}';

SELECT throws_ok($$ UPDATE public.tenant_memberships SET status = 'inactive'
                    WHERE user_id = '00000000-0000-4000-8000-0000000008a1' $$,
    '23514', NULL, 'platform admin: cannot deactivate the last active owner');
SELECT throws_ok($$ UPDATE public.tenant_memberships SET role = 'admin'
                    WHERE user_id = '00000000-0000-4000-8000-0000000008a1' $$,
    '23514', NULL, 'platform admin: cannot downgrade the last active owner');
SELECT throws_ok($$ DELETE FROM public.tenant_memberships
                    WHERE user_id = '00000000-0000-4000-8000-0000000008a1' $$,
    '23514', NULL, 'platform admin: cannot remove the last active owner');
SELECT throws_ok($$ UPDATE public.tenant_memberships SET status = 'invited'
                    WHERE user_id = '00000000-0000-4000-8000-0000000008a1' $$,
    '23514', NULL, 'platform admin: cannot set the last owner back to invited');
SELECT throws_ok($$ UPDATE public.tenant_memberships SET tenant_id = 'b8000000-0000-4000-8000-000000000000'
                    WHERE user_id = '00000000-0000-4000-8000-0000000008a1' $$,
    '23514', NULL, 'platform admin: cannot move the last owner to another tenant');
SELECT throws_ok($$ UPDATE public.tenant_memberships SET user_id = '00000000-0000-4000-8000-0000000008a3', role = 'owner'
                    WHERE user_id = '00000000-0000-4000-8000-0000000008a1' $$,
    '23514', NULL, 'platform admin: cannot hand the last owner row to another user');

-- Same through the RPCs
SELECT throws_ok($$ SELECT public.deactivate_member('a8000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000008a1') $$,
    '23514', NULL, 'platform admin RPC: cannot deactivate the last active owner');
SELECT throws_ok($$ SELECT public.change_member_role('a8000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000008a1', 'client') $$,
    '23514', NULL, 'platform admin RPC: cannot downgrade the last active owner');

-- An inactive owner does not count as a remaining owner.
SELECT throws_ok($$ UPDATE public.tenant_memberships SET role = 'admin'
                    WHERE user_id = '00000000-0000-4000-8000-0000000008c1' $$,
    '23514', NULL, 'inactive owners do not count towards the last-owner rule');

-- Changes to non-owners are unaffected.
SELECT lives_ok($$ DELETE FROM public.tenant_memberships WHERE user_id = '00000000-0000-4000-8000-0000000008a3' $$,
    'platform admin: can remove a non-owner member');
SELECT lives_ok($$ UPDATE public.tenant_memberships SET status = 'active', role = 'owner'
                   WHERE user_id = '00000000-0000-4000-8000-0000000008c2' $$,
    'platform admin: can reactivate an inactive owner');

-- Successful changes once another active owner exists
SELECT lives_ok($$ UPDATE public.tenant_memberships SET role = 'admin'
                   WHERE user_id = '00000000-0000-4000-8000-0000000008b1' $$,
    'two owners: one can be downgraded');
SELECT throws_ok($$ DELETE FROM public.tenant_memberships WHERE user_id = '00000000-0000-4000-8000-0000000008b2' $$,
    '23514', NULL, 'two owners: the remaining one is protected again');

SELECT lives_ok($$ SELECT public.change_member_role('a8000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000008a2', 'owner') $$,
    'tenant A: second owner added');
SELECT lives_ok($$ SELECT public.deactivate_member('a8000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000008a1') $$,
    'tenant A: original owner can now be deactivated (RPC)');
SELECT lives_ok($$ DELETE FROM public.tenant_memberships WHERE user_id = '00000000-0000-4000-8000-0000000008a1' $$,
    'tenant A: deactivated former owner can be removed');
SELECT lives_ok($$ UPDATE public.tenant_memberships SET status = 'inactive'
                   WHERE user_id = '00000000-0000-4000-8000-0000000008c1' $$,
    'tenant C: owner can be deactivated now that the other owner is active');

RESET ROLE;
SELECT results_eq(
    $$ SELECT tenant_id, count(*)::int FROM public.tenant_memberships
       WHERE tenant_id IN ('a8000000-0000-4000-8000-000000000000', 'b8000000-0000-4000-8000-000000000000', 'c8000000-0000-4000-8000-000000000000')
         AND role = 'owner' AND status = 'active'
       GROUP BY tenant_id ORDER BY tenant_id $$,
    $$ VALUES ('a8000000-0000-4000-8000-000000000000'::uuid, 1),
              ('b8000000-0000-4000-8000-000000000000'::uuid, 1),
              ('c8000000-0000-4000-8000-000000000000'::uuid, 1) $$,
    'every tenant still has exactly one active owner');


-- =====================================================
-- service_role and the table owner are bound by the same rule
-- =====================================================
SET LOCAL ROLE service_role;
SET LOCAL request.jwt.claims TO '{"role":"service_role"}';
SELECT throws_ok($$ UPDATE public.tenant_memberships SET status = 'inactive'
                    WHERE user_id = '00000000-0000-4000-8000-0000000008d1' $$,
    '23514', NULL, 'service_role: cannot deactivate the last active owner');
SELECT throws_ok($$ DELETE FROM public.tenant_memberships WHERE user_id = '00000000-0000-4000-8000-0000000008d1' $$,
    '23514', NULL, 'service_role: cannot remove the last active owner');
RESET ROLE;

SELECT throws_ok($$ UPDATE public.tenant_memberships SET role = 'viewer'
                    WHERE user_id = '00000000-0000-4000-8000-0000000008d1' $$,
    '23514', NULL, 'table owner (SQL): cannot downgrade the last active owner');


-- =====================================================
-- Cascades are allowed: deleting the tenant or the owner's account
-- =====================================================
SELECT lives_ok($$ DELETE FROM public.tenants WHERE id = 'e8000000-0000-4000-8000-000000000000' $$,
    'deleting a tenant removes its last owner by cascade');
SELECT lives_ok($$ DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000000008d1' $$,
    'deleting the owner''s auth account removes the membership by cascade');
SELECT is((SELECT count(*)::int FROM public.tenant_memberships WHERE tenant_id = 'd8000000-0000-4000-8000-000000000000'),
    0, 'account deletion leaves the tenant ownerless (platform admin must assign a new owner)');

SELECT * FROM finish();
ROLLBACK;
