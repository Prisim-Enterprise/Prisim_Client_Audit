-- =====================================================
-- 11 - Staff-only client management (20261113120000)
-- Run locally with: npx supabase test db
--
-- Client onboarding, users, roles, access and ad-account connections are
-- managed only by PRISIM staff (aal2 platform admins). Every client role is
-- denied every staff operation, through RPCs and direct table API calls;
-- staff with aal2 can perform all of them; aal1 staff cannot.
--
-- Fixture map
--   Tenant A  ab110000-...  active: owner o1, admin d1, manager m1, viewer v1,
--                                   client c1, INACTIVE client x1
--   Tenant B  bb110000-...  active: owner o2
--   ...11ad  platform admin    ...11ee  signed-in user with no membership
--   Connection A ab110000-...c0 with accounts aa (enabled) and ab (disabled)
--   Pending invitation for outsider@t11.test (token "t11-invitation-token-0123456789abcdef")
-- =====================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT no_plan();

INSERT INTO auth.users (id, email, email_confirmed_at, aud, role) VALUES
    ('00000000-0000-4000-8000-0000000011a1', 'owner@t11.test',    NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000011a2', 'admin@t11.test',    NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000011a3', 'manager@t11.test',  NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000011a4', 'viewer@t11.test',   NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000011a5', 'client@t11.test',   NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000011a6', 'inactive@t11.test', NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000011b1', 'owner@b11.test',    NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000011ee', 'outsider@t11.test', NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000011ad', 'staff@p11.test',    NOW(), 'authenticated', 'authenticated');
INSERT INTO public.platform_admins (user_id) VALUES ('00000000-0000-4000-8000-0000000011ad');

INSERT INTO public.tenants (id, business_name, slug, status) VALUES
    ('ab110000-0000-4000-8000-000000000000', 'Staff Only A', 'staff-only-a', 'active'),
    ('bb110000-0000-4000-8000-000000000000', 'Staff Only B', 'staff-only-b', 'active');

INSERT INTO public.tenant_memberships (tenant_id, user_id, role, status) VALUES
    ('ab110000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000011a1', 'owner',   'active'),
    ('ab110000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000011a2', 'admin',   'active'),
    ('ab110000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000011a3', 'manager', 'active'),
    ('ab110000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000011a4', 'viewer',  'active'),
    ('ab110000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000011a5', 'client',  'active'),
    ('ab110000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000011a6', 'client',  'inactive'),
    ('bb110000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000011b1', 'owner',   'active');

INSERT INTO public.oauth_connections (id, tenant_id, provider, status) VALUES
    ('ab110000-0000-4000-8000-0000000000c0', 'ab110000-0000-4000-8000-000000000000', 'meta', 'connected'),
    ('bb110000-0000-4000-8000-0000000000c0', 'bb110000-0000-4000-8000-000000000000', 'meta', 'connected');
INSERT INTO public.ad_accounts (id, tenant_id, connection_id, provider, external_account_id, sync_enabled) VALUES
    ('ab110000-0000-4000-8000-0000000000aa', 'ab110000-0000-4000-8000-000000000000', 'ab110000-0000-4000-8000-0000000000c0', 'meta', 'act_t11a', TRUE),
    ('ab110000-0000-4000-8000-0000000000ab', 'ab110000-0000-4000-8000-000000000000', 'ab110000-0000-4000-8000-0000000000c0', 'meta', 'act_t11b', FALSE),
    ('bb110000-0000-4000-8000-0000000000aa', 'bb110000-0000-4000-8000-000000000000', 'bb110000-0000-4000-8000-0000000000c0', 'meta', 'act_t11c', TRUE);
INSERT INTO public.tenant_invitations (id, tenant_id, email, role, token_hash) VALUES
    ('ab110000-0000-4000-8000-0000000000e1', 'ab110000-0000-4000-8000-000000000000', 'outsider@t11.test', 'viewer',
     encode(sha256('t11-invitation-token-0123456789abcdef'::bytea), 'hex'));

-- Snapshot of everything a client could try to change.
CREATE TEMP TABLE before_state AS
SELECT (SELECT jsonb_agg(jsonb_build_array(tenant_id, user_id, role, status) ORDER BY tenant_id, user_id) FROM public.tenant_memberships
        WHERE tenant_id IN ('ab110000-0000-4000-8000-000000000000', 'bb110000-0000-4000-8000-000000000000')) AS memberships,
       (SELECT jsonb_agg(jsonb_build_array(id, status) ORDER BY id) FROM public.tenant_invitations
        WHERE tenant_id = 'ab110000-0000-4000-8000-000000000000') AS invitations,
       (SELECT jsonb_agg(jsonb_build_array(id, status) ORDER BY id) FROM public.oauth_connections
        WHERE tenant_id IN ('ab110000-0000-4000-8000-000000000000', 'bb110000-0000-4000-8000-000000000000')) AS connections,
       (SELECT jsonb_agg(jsonb_build_array(id, sync_enabled) ORDER BY id) FROM public.ad_accounts
        WHERE tenant_id IN ('ab110000-0000-4000-8000-000000000000', 'bb110000-0000-4000-8000-000000000000')) AS accounts,
       (SELECT jsonb_agg(jsonb_build_array(id, business_name, status) ORDER BY id) FROM public.tenants
        WHERE id IN ('ab110000-0000-4000-8000-000000000000', 'bb110000-0000-4000-8000-000000000000')) AS tenants;

-- -----------------------------------------------------
-- Helpers (SECURITY INVOKER: they run as the current role)
--   denied(sql)  : TRUE when the statement raises insufficient_privilege
--                  (42501) or, for UPDATE/DELETE, changes no row.
--                  Any other error propagates and fails the test.
-- -----------------------------------------------------
CREATE FUNCTION pg_temp.denied(p_sql TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
    v_rows BIGINT;
BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN p_sql ~* '^\s*(update|delete)\M' AND v_rows = 0;
EXCEPTION WHEN insufficient_privilege THEN
    RETURN TRUE;
END;
$$;

-- Every staff operation, as a client would attempt it through the API.
CREATE TEMP TABLE staff_ops (n INT PRIMARY KEY, label TEXT, sql TEXT);
INSERT INTO staff_ops VALUES
    -- member management RPCs
    ( 1, 'change another member''s role',     $q$SELECT public.change_member_role('ab110000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000011a4', 'client')$q$),
    ( 2, 'promote self to owner',              $q$SELECT public.change_member_role('ab110000-0000-4000-8000-000000000000', (SELECT auth.uid()), 'owner')$q$),
    ( 3, 'deactivate a member',                $q$SELECT public.deactivate_member('ab110000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000011a4')$q$),
    ( 4, 'revoke an invitation',               $q$SELECT public.revoke_invitation('ab110000-0000-4000-8000-0000000000e1')$q$),
    ( 5, 'accept an invitation (retired)',     $q$SELECT public.accept_invitation('t11-invitation-token-0123456789abcdef')$q$),
    ( 6, 'list members',                       $q$SELECT * FROM public.get_tenant_members('ab110000-0000-4000-8000-000000000000')$q$),
    -- connections and sync
    ( 7, 'start an OAuth connection',          $q$SELECT public.begin_privileged_action('ab110000-0000-4000-8000-000000000000', 'oauth.connect')$q$),
    ( 8, 'disconnect',                         $q$SELECT public.begin_privileged_action('ab110000-0000-4000-8000-000000000000', 'oauth.disconnect', 'ab110000-0000-4000-8000-0000000000c0')$q$),
    ( 9, 'start a sync',                       $q$SELECT public.begin_privileged_action('ab110000-0000-4000-8000-000000000000', 'sync.start', 'ab110000-0000-4000-8000-0000000000c0')$q$),
    (10, 'authorize report generation',        $q$SELECT public.begin_privileged_action('ab110000-0000-4000-8000-000000000000', 'report.generate')$q$),
    (11, 'authorize an invitation',            $q$SELECT public.begin_privileged_action('ab110000-0000-4000-8000-000000000000', 'invitation.create')$q$),
    (12, 'change account selection',           $q$SELECT public.set_ad_account_sync('ab110000-0000-4000-8000-0000000000c0', ARRAY['ab110000-0000-4000-8000-0000000000ab']::UUID[])$q$),
    -- direct table API: memberships
    (13, 'add a user to the tenant',           $q$INSERT INTO public.tenant_memberships (tenant_id, user_id, role) VALUES ('ab110000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000011ee', 'viewer')$q$),
    (14, 'join another tenant',                $q$INSERT INTO public.tenant_memberships (tenant_id, user_id, role) VALUES ('bb110000-0000-4000-8000-000000000000', (SELECT auth.uid()), 'owner')$q$),
    (15, 'change roles directly',              $q$UPDATE public.tenant_memberships SET role = 'owner' WHERE tenant_id = 'ab110000-0000-4000-8000-000000000000'$q$),
    (16, 'reactivate a member directly',       $q$UPDATE public.tenant_memberships SET status = 'active' WHERE user_id = '00000000-0000-4000-8000-0000000011a6'$q$),
    (17, 'deactivate members directly',        $q$UPDATE public.tenant_memberships SET status = 'inactive' WHERE user_id <> (SELECT auth.uid())$q$),
    (18, 'remove members directly',            $q$DELETE FROM public.tenant_memberships WHERE tenant_id = 'ab110000-0000-4000-8000-000000000000' AND user_id <> (SELECT auth.uid())$q$),
    -- direct table API: tenants, invitations, connections, accounts, staff
    (19, 'create a client organisation',       $q$INSERT INTO public.tenants (business_name, slug) VALUES ('Rogue', 'rogue-t11')$q$),
    (20, 'edit the organisation',              $q$UPDATE public.tenants SET business_name = 'Changed' WHERE id = 'ab110000-0000-4000-8000-000000000000'$q$),
    (21, 'suspend the organisation',           $q$UPDATE public.tenants SET status = 'suspended' WHERE id = 'ab110000-0000-4000-8000-000000000000'$q$),
    (22, 'create an invitation directly',      $q$INSERT INTO public.tenant_invitations (tenant_id, email, token_hash) VALUES ('ab110000-0000-4000-8000-000000000000', 'x@t11.test', repeat('a', 64))$q$),
    (23, 'revoke invitations directly',        $q$UPDATE public.tenant_invitations SET status = 'revoked'$q$),
    (24, 'create a connection directly',       $q$INSERT INTO public.oauth_connections (tenant_id, provider) VALUES ('ab110000-0000-4000-8000-000000000000', 'google')$q$),
    (25, 'change a connection status',         $q$UPDATE public.oauth_connections SET status = 'revoked'$q$),
    (26, 'delete a connection',                $q$DELETE FROM public.oauth_connections$q$),
    (27, 'add an ad account',                  $q$INSERT INTO public.ad_accounts (tenant_id, provider, external_account_id) VALUES ('ab110000-0000-4000-8000-000000000000', 'google', 'rogue-1')$q$),
    (28, 'enable sync on an account directly', $q$UPDATE public.ad_accounts SET sync_enabled = TRUE$q$),
    (29, 'grant platform admin',               $q$INSERT INTO public.platform_admins (user_id) VALUES ((SELECT auth.uid()))$q$),
    (30, 'call a service_role RPC',            $q$SELECT public.create_oauth_connection(gen_random_uuid(), 'ab110000-0000-4000-8000-000000000000', 'google')$q$),
    (31, 'read OAuth tokens',                  $q$SELECT * FROM public.get_oauth_tokens('ab110000-0000-4000-8000-0000000000c0')$q$);
GRANT SELECT ON staff_ops, before_state TO authenticated;

-- Who tries.
CREATE TEMP TABLE actors (label TEXT, claims TEXT);
INSERT INTO actors VALUES
    ('owner',            '{"sub":"00000000-0000-4000-8000-0000000011a1","role":"authenticated"}'),
    ('owner aal2',       '{"sub":"00000000-0000-4000-8000-0000000011a1","role":"authenticated","aal":"aal2"}'),
    ('admin',            '{"sub":"00000000-0000-4000-8000-0000000011a2","role":"authenticated"}'),
    ('manager',          '{"sub":"00000000-0000-4000-8000-0000000011a3","role":"authenticated"}'),
    ('viewer',           '{"sub":"00000000-0000-4000-8000-0000000011a4","role":"authenticated"}'),
    ('client',           '{"sub":"00000000-0000-4000-8000-0000000011a5","role":"authenticated"}'),
    ('inactive member',  '{"sub":"00000000-0000-4000-8000-0000000011a6","role":"authenticated"}'),
    ('other tenant owner','{"sub":"00000000-0000-4000-8000-0000000011b1","role":"authenticated"}'),
    ('no membership',    '{"sub":"00000000-0000-4000-8000-0000000011ee","role":"authenticated"}'),
    ('staff aal1',       '{"sub":"00000000-0000-4000-8000-0000000011ad","role":"authenticated","aal":"aal1"}'),
    ('staff no aal',     '{"sub":"00000000-0000-4000-8000-0000000011ad","role":"authenticated"}');
GRANT SELECT ON actors TO authenticated;
CREATE TEMP TABLE staff_acts (label TEXT PRIMARY KEY, id UUID);
GRANT ALL ON staff_acts TO authenticated, service_role;


-- =====================================================
-- 1. Every client role (and staff without MFA) is denied every staff operation
-- =====================================================
SET LOCAL ROLE authenticated;

SELECT set_config('request.jwt.claims', (SELECT claims FROM actors WHERE label = 'owner'), TRUE);
SELECT ok(pg_temp.denied(sql), 'owner: cannot ' || label) FROM staff_ops ORDER BY n;
SELECT set_config('request.jwt.claims', (SELECT claims FROM actors WHERE label = 'owner aal2'), TRUE);
SELECT ok(pg_temp.denied(sql), 'owner with aal2: cannot ' || label) FROM staff_ops ORDER BY n;
SELECT set_config('request.jwt.claims', (SELECT claims FROM actors WHERE label = 'admin'), TRUE);
SELECT ok(pg_temp.denied(sql), 'admin: cannot ' || label) FROM staff_ops ORDER BY n;
SELECT set_config('request.jwt.claims', (SELECT claims FROM actors WHERE label = 'manager'), TRUE);
SELECT ok(pg_temp.denied(sql), 'manager: cannot ' || label) FROM staff_ops ORDER BY n;
SELECT set_config('request.jwt.claims', (SELECT claims FROM actors WHERE label = 'viewer'), TRUE);
SELECT ok(pg_temp.denied(sql), 'viewer: cannot ' || label) FROM staff_ops ORDER BY n;
SELECT set_config('request.jwt.claims', (SELECT claims FROM actors WHERE label = 'client'), TRUE);
SELECT ok(pg_temp.denied(sql), 'client: cannot ' || label) FROM staff_ops ORDER BY n;
SELECT set_config('request.jwt.claims', (SELECT claims FROM actors WHERE label = 'inactive member'), TRUE);
SELECT ok(pg_temp.denied(sql), 'inactive member: cannot ' || label) FROM staff_ops ORDER BY n;
SELECT set_config('request.jwt.claims', (SELECT claims FROM actors WHERE label = 'other tenant owner'), TRUE);
SELECT ok(pg_temp.denied(sql), 'other tenant owner: cannot ' || label) FROM staff_ops ORDER BY n;
SELECT set_config('request.jwt.claims', (SELECT claims FROM actors WHERE label = 'no membership'), TRUE);
SELECT ok(pg_temp.denied(sql), 'user without membership: cannot ' || label) FROM staff_ops ORDER BY n;
SELECT set_config('request.jwt.claims', (SELECT claims FROM actors WHERE label = 'staff aal1'), TRUE);
SELECT ok(pg_temp.denied(sql), 'staff aal1: cannot ' || label) FROM staff_ops ORDER BY n;
SELECT set_config('request.jwt.claims', (SELECT claims FROM actors WHERE label = 'staff no aal'), TRUE);
SELECT ok(pg_temp.denied(sql), 'staff without aal claim: cannot ' || label) FROM staff_ops ORDER BY n;

RESET ROLE;
SELECT is((SELECT memberships FROM before_state),
          (SELECT jsonb_agg(jsonb_build_array(tenant_id, user_id, role, status) ORDER BY tenant_id, user_id) FROM public.tenant_memberships
           WHERE tenant_id IN ('ab110000-0000-4000-8000-000000000000', 'bb110000-0000-4000-8000-000000000000')),
    'after all client attempts: memberships unchanged');
SELECT is((SELECT invitations FROM before_state),
          (SELECT jsonb_agg(jsonb_build_array(id, status) ORDER BY id) FROM public.tenant_invitations
           WHERE tenant_id = 'ab110000-0000-4000-8000-000000000000'),
    'after all client attempts: invitations unchanged');
SELECT is((SELECT connections FROM before_state),
          (SELECT jsonb_agg(jsonb_build_array(id, status) ORDER BY id) FROM public.oauth_connections
           WHERE tenant_id IN ('ab110000-0000-4000-8000-000000000000', 'bb110000-0000-4000-8000-000000000000')),
    'after all client attempts: connections unchanged');
SELECT is((SELECT accounts FROM before_state),
          (SELECT jsonb_agg(jsonb_build_array(id, sync_enabled) ORDER BY id) FROM public.ad_accounts
           WHERE tenant_id IN ('ab110000-0000-4000-8000-000000000000', 'bb110000-0000-4000-8000-000000000000')),
    'after all client attempts: ad accounts and sync selection unchanged');
SELECT is((SELECT tenants FROM before_state),
          (SELECT jsonb_agg(jsonb_build_array(id, business_name, status) ORDER BY id) FROM public.tenants
           WHERE id IN ('ab110000-0000-4000-8000-000000000000', 'bb110000-0000-4000-8000-000000000000')),
    'after all client attempts: organisations unchanged');
SELECT is((SELECT count(*)::int FROM public.tenants WHERE slug = 'rogue-t11'), 0, 'after all client attempts: no organisation created');
SELECT is((SELECT count(*)::int FROM private.privileged_actions
           WHERE tenant_id = 'ab110000-0000-4000-8000-000000000000'), 0,
    'after all client attempts: no privileged action was created');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id IN (
        '00000000-0000-4000-8000-0000000011a1', '00000000-0000-4000-8000-0000000011a2', '00000000-0000-4000-8000-0000000011a3',
        '00000000-0000-4000-8000-0000000011a4', '00000000-0000-4000-8000-0000000011a5', '00000000-0000-4000-8000-0000000011a6',
        '00000000-0000-4000-8000-0000000011b1', '00000000-0000-4000-8000-0000000011ee')),
    'after all client attempts: no client became a platform admin');


-- =====================================================
-- 2. Client reads: own business data only, no staff-managed data
-- =====================================================
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', (SELECT claims FROM actors WHERE label = 'owner'), TRUE);
SELECT results_eq($$ SELECT id FROM public.tenants $$,
    $$ VALUES ('ab110000-0000-4000-8000-000000000000'::uuid) $$, 'owner reads: own organisation');
SELECT results_eq($$ SELECT id FROM public.ad_accounts ORDER BY id $$,
    $$ VALUES ('ab110000-0000-4000-8000-0000000000aa'::uuid), ('ab110000-0000-4000-8000-0000000000ab'::uuid) $$,
    'owner reads: own ad accounts');
SELECT results_eq($$ SELECT user_id FROM public.tenant_memberships $$,
    $$ VALUES ('00000000-0000-4000-8000-0000000011a1'::uuid) $$, 'owner reads: only own membership');
SELECT results_eq($$ SELECT id FROM public.profiles $$,
    $$ VALUES ('00000000-0000-4000-8000-0000000011a1'::uuid) $$, 'owner reads: only own profile');
SELECT is_empty($$ SELECT id FROM public.tenant_invitations $$, 'owner reads: no invitations');
SELECT is_empty($$ SELECT id FROM public.oauth_connections $$,  'owner reads: no connections');
SELECT is_empty($$ SELECT id FROM public.audit_logs $$,         'owner reads: no audit log');
SELECT ok((SELECT count(*) FROM public.get_tenant_sync_status('ab110000-0000-4000-8000-000000000000')) >= 0,
    'owner reads: sanitized sync status is still available');
WITH u AS (UPDATE public.profiles SET full_name = 'Owner T11' WHERE id = (SELECT auth.uid()) RETURNING 1)
SELECT is(count(*)::int, 1, 'owner: can still edit own profile name') FROM u;

SELECT set_config('request.jwt.claims', (SELECT claims FROM actors WHERE label = 'admin'), TRUE);
SELECT results_eq($$ SELECT user_id FROM public.tenant_memberships $$,
    $$ VALUES ('00000000-0000-4000-8000-0000000011a2'::uuid) $$, 'admin reads: only own membership');
SELECT is_empty($$ SELECT id FROM public.audit_logs $$,         'admin reads: no audit log');
SELECT is_empty($$ SELECT id FROM public.tenant_invitations $$, 'admin reads: no invitations');

SELECT set_config('request.jwt.claims', (SELECT claims FROM actors WHERE label = 'manager'), TRUE);
SELECT is_empty($$ SELECT id FROM public.oauth_connections $$,  'manager reads: no connections');
SELECT results_eq($$ SELECT id FROM public.profiles $$,
    $$ VALUES ('00000000-0000-4000-8000-0000000011a3'::uuid) $$, 'manager reads: only own profile');

SELECT set_config('request.jwt.claims', (SELECT claims FROM actors WHERE label = 'other tenant owner'), TRUE);
SELECT is_empty($$ SELECT id FROM public.ad_accounts WHERE tenant_id = 'ab110000-0000-4000-8000-000000000000' $$,
    'tenant isolation: owner of B sees nothing of A');


-- =====================================================
-- 3. PRISIM staff (aal2) keep every management capability
-- =====================================================
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000011ad","role":"authenticated","aal":"aal2"}', TRUE);

SELECT is((SELECT count(*)::int FROM public.get_tenant_members('ab110000-0000-4000-8000-000000000000')), 6,
    'staff: lists all members');
SELECT is((SELECT count(*)::int FROM public.tenant_memberships WHERE tenant_id = 'ab110000-0000-4000-8000-000000000000'), 6,
    'staff: reads all memberships');
SELECT is((SELECT count(*)::int FROM public.oauth_connections WHERE tenant_id = 'ab110000-0000-4000-8000-000000000000'), 1,
    'staff: reads connections');
SELECT is((SELECT count(*)::int FROM public.tenant_invitations WHERE tenant_id = 'ab110000-0000-4000-8000-000000000000'), 1,
    'staff: reads invitations');
SELECT ok((SELECT count(*) FROM public.profiles WHERE id IN ('00000000-0000-4000-8000-0000000011a1', '00000000-0000-4000-8000-0000000011b1')) = 2,
    'staff: reads profiles across tenants');

SELECT lives_ok($$ INSERT INTO public.tenants (id, business_name, slug) VALUES ('cb110000-0000-4000-8000-000000000000', 'New Client', 'new-client-t11') $$,
    'staff: creates a client organisation');
SELECT lives_ok($$ UPDATE public.tenants SET business_name = 'Staff Only A (edited)' WHERE id = 'ab110000-0000-4000-8000-000000000000' $$,
    'staff: edits organisation details');
SELECT lives_ok($$ INSERT INTO public.tenant_memberships (tenant_id, user_id, role) VALUES ('cb110000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000011ee', 'owner') $$,
    'staff: assigns a user to an organisation (manage-tenant-user path)');
SELECT lives_ok($$ SELECT public.change_member_role('ab110000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000011a4', 'client') $$,
    'staff: changes a member''s role');
SELECT lives_ok($$ SELECT public.deactivate_member('ab110000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000011a5') $$,
    'staff: removes a member''s access');
SELECT lives_ok($$ UPDATE public.tenant_memberships SET status = 'active', role = 'viewer' WHERE user_id = '00000000-0000-4000-8000-0000000011a6' $$,
    'staff: restores a member''s access');
SELECT throws_ok($$ SELECT public.deactivate_member('bb110000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000011b1') $$,
    '23514', NULL, 'staff: last-owner protection still applies');
SELECT lives_ok($$ SELECT public.revoke_invitation('ab110000-0000-4000-8000-0000000000e1') $$,
    'staff: revokes an invitation');
SELECT is(public.set_ad_account_sync('ab110000-0000-4000-8000-0000000000c0',
          ARRAY['ab110000-0000-4000-8000-0000000000aa', 'ab110000-0000-4000-8000-0000000000ab']::UUID[]), 2,
    'staff: selects the accounts to sync');
INSERT INTO staff_acts SELECT 'connect',    action_id FROM public.begin_privileged_action('ab110000-0000-4000-8000-000000000000', 'oauth.connect');
INSERT INTO staff_acts SELECT 'disconnect', action_id FROM public.begin_privileged_action('ab110000-0000-4000-8000-000000000000', 'oauth.disconnect', 'ab110000-0000-4000-8000-0000000000c0');
INSERT INTO staff_acts SELECT 'sync',       action_id FROM public.begin_privileged_action('ab110000-0000-4000-8000-000000000000', 'sync.start', 'ab110000-0000-4000-8000-0000000000c0');
INSERT INTO staff_acts SELECT 'report',     action_id FROM public.begin_privileged_action('ab110000-0000-4000-8000-000000000000', 'report.generate');
SELECT is((SELECT count(*)::int FROM staff_acts), 4, 'staff: starts connect, disconnect, sync and report actions');
SELECT throws_ok($$ SELECT public.accept_invitation('t11-invitation-token-0123456789abcdef') $$,
    '42501', NULL, 'staff: the retired invitation acceptance is closed for staff too');

-- The connect action completes through the service_role RPCs (OAuth start → callback).
RESET ROLE;
SET LOCAL ROLE service_role;
SET LOCAL request.jwt.claims TO '{"role":"service_role"}';
CREATE TEMP TABLE staff_conn AS
SELECT public.create_oauth_connection((SELECT id FROM staff_acts WHERE label = 'connect'), 'ab110000-0000-4000-8000-000000000000', 'google') AS id;
SELECT ok((SELECT id IS NOT NULL FROM staff_conn), 'staff OAuth: pending connection created for the staff action');
SELECT lives_ok(format('SELECT public.store_oauth_tokens(%L, %L, %L, NULL, %L)',
                       (SELECT id FROM staff_conn), 'staff-access', 'staff-refresh', (SELECT id FROM staff_acts WHERE label = 'connect')),
    'staff OAuth: callback stores tokens in Vault for the same action');
SELECT is(public.upsert_discovered_ad_accounts((SELECT id FROM staff_acts WHERE label = 'connect'), (SELECT id FROM staff_conn),
          '[{"external_account_id":"1234567890","account_name":"Discovered","currency":"INR","status":"active"}]'::JSONB, NULL, 'Google Ads', ARRAY['adwords']),
          1, 'staff OAuth: discovered accounts saved for the same action');
SELECT set_config('prisim.privileged_action_id', '', TRUE);
SELECT ok(public.start_sync_job((SELECT id FROM staff_acts WHERE label = 'sync'), 'ab110000-0000-4000-8000-0000000000c0') IS NOT NULL,
    'staff sync: manual sync queued for the staff action');
-- Scheduled sync needs no user action (cron secret path).
SELECT set_config('prisim.privileged_action_id', '', TRUE);
SELECT ok(public.enqueue_scheduled_sync_jobs() >= 0, 'scheduled sync: service_role enqueue still works without a user action');
RESET ROLE;

SELECT results_eq(
    $$ SELECT user_id FROM public.audit_logs
       WHERE action = 'oauth_connections.insert' AND entity_id = (SELECT id FROM staff_conn) $$,
    $$ VALUES ('00000000-0000-4000-8000-0000000011ad'::uuid) $$,
    'audit: staff connection attributed to the staff member');
SELECT ok(EXISTS (SELECT 1 FROM public.audit_logs
                  WHERE action = 'tenant_memberships.update' AND user_id = '00000000-0000-4000-8000-0000000011ad'
                    AND details -> 'new' ->> 'user_id' = '00000000-0000-4000-8000-0000000011a4'),
    'audit: staff role change attributed to the staff member');

SELECT * FROM finish();
ROLLBACK;
