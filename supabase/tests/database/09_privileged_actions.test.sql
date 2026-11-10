-- =====================================================
-- 09 - Privileged actions: attribution of service_role work to the
--      authenticated user who initiated it
-- Run locally with: npx supabase test db
--
-- Fixture map
--   Tenant A  a9...  active:    owner ...09a1, manager ...09a2, client ...09a3
--   Tenant B  b9...  active:    manager ...09b1
--   Tenant S  c9...  suspended: manager ...09c1
--   ...09ad   platform admin
--   Connections: A ...a9..c0 (connected), B ...b9..c0 (connected)
--
-- Note: in production every PostgREST call is its own transaction. These
-- tests share one transaction, so they clear the per-transaction binding
-- (prisim.privileged_action_id) explicitly where a new "request" starts.
-- =====================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT no_plan();

INSERT INTO auth.users (id, email, email_confirmed_at, aud, role) VALUES
    ('00000000-0000-4000-8000-0000000009a1', 'owner@a9.test',   NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000009a2', 'manager@a9.test', NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000009a3', 'client@a9.test',  NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000009b1', 'manager@b9.test', NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000009c1', 'manager@c9.test', NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000009ad', 'staff@p9.test',   NOW(), 'authenticated', 'authenticated');
INSERT INTO public.platform_admins (user_id) VALUES ('00000000-0000-4000-8000-0000000009ad');

INSERT INTO public.tenants (id, business_name, slug, status) VALUES
    ('a9000000-0000-4000-8000-000000000000', 'Actions A', 'actions-a', 'active'),
    ('b9000000-0000-4000-8000-000000000000', 'Actions B', 'actions-b', 'active'),
    ('c9000000-0000-4000-8000-000000000000', 'Actions S', 'actions-s', 'suspended');

INSERT INTO public.tenant_memberships (tenant_id, user_id, role) VALUES
    ('a9000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000009a1', 'owner'),
    ('a9000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000009a2', 'manager'),
    ('a9000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000009a3', 'client'),
    ('b9000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000009b1', 'owner'),
    ('c9000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000009c1', 'manager');

INSERT INTO public.oauth_connections (id, tenant_id, provider, status) VALUES
    ('a9000000-0000-4000-8000-0000000000c0', 'a9000000-0000-4000-8000-000000000000', 'meta', 'connected'),
    ('b9000000-0000-4000-8000-0000000000c0', 'b9000000-0000-4000-8000-000000000000', 'meta', 'connected');

-- Action ids handed from the "browser step" to the "Edge Function step".
CREATE TEMP TABLE acts (label TEXT PRIMARY KEY, id UUID);
GRANT ALL ON acts TO authenticated, service_role;


-- =====================================================
-- Step 1: begin_privileged_action with the user's own JWT
-- =====================================================
SET LOCAL ROLE authenticated;

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000009a3","role":"authenticated"}';
SELECT throws_ok($$ SELECT public.begin_privileged_action('a9000000-0000-4000-8000-000000000000', 'oauth.connect') $$,
    '42501', NULL, 'client: cannot start privileged actions');

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000009c1","role":"authenticated"}';
SELECT throws_ok($$ SELECT public.begin_privileged_action('c9000000-0000-4000-8000-000000000000', 'oauth.connect') $$,
    '42501', NULL, 'suspended tenant manager: cannot start privileged actions');

SET LOCAL request.jwt.claims TO '{"role":"authenticated"}';
SELECT throws_ok($$ SELECT public.begin_privileged_action('a9000000-0000-4000-8000-000000000000', 'oauth.connect') $$,
    '42501', NULL, 'no sub: cannot start privileged actions');

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000009ad","role":"authenticated","aal":"aal1"}';
SELECT throws_ok($$ SELECT public.begin_privileged_action('a9000000-0000-4000-8000-000000000000', 'oauth.connect') $$,
    '42501', NULL, 'platform admin aal1: cannot start privileged actions');

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000009a2","role":"authenticated"}';
SELECT throws_ok($$ SELECT public.begin_privileged_action('b9000000-0000-4000-8000-000000000000', 'oauth.connect') $$,
    '42501', NULL, 'manager A: cannot start actions for tenant B');
SELECT throws_ok($$ SELECT public.begin_privileged_action('a9000000-0000-4000-8000-000000000000', 'sync.start', 'b9000000-0000-4000-8000-0000000000c0') $$,
    '22023', NULL, 'manager A: cannot target another tenant''s connection');
SELECT throws_ok($$ SELECT public.begin_privileged_action('a9000000-0000-4000-8000-000000000000', 'tenant.delete') $$,
    '22023', NULL, 'unknown action rejected');
SELECT throws_ok($$ SELECT public.begin_privileged_action('a9000000-0000-4000-8000-000000000000', 'sync.start') $$,
    '22023', NULL, 'sync.start requires a target connection');

INSERT INTO acts SELECT 'connect',    action_id FROM public.begin_privileged_action('a9000000-0000-4000-8000-000000000000', 'oauth.connect');
INSERT INTO acts SELECT 'sync',       action_id FROM public.begin_privileged_action('a9000000-0000-4000-8000-000000000000', 'sync.start', 'a9000000-0000-4000-8000-0000000000c0');
INSERT INTO acts SELECT 'disconnect', action_id FROM public.begin_privileged_action('a9000000-0000-4000-8000-000000000000', 'oauth.disconnect', 'a9000000-0000-4000-8000-0000000000c0');
INSERT INTO acts SELECT 'expiring',   action_id FROM public.begin_privileged_action('a9000000-0000-4000-8000-000000000000', 'oauth.connect');
SELECT is((SELECT count(*)::int FROM acts), 4, 'manager A: starts privileged actions for own tenant');

SELECT throws_ok($$ SELECT * FROM private.privileged_actions $$,
    '42501', NULL, 'authenticated: cannot read the privileged action table');
SELECT throws_ok($$ SELECT public.create_oauth_connection((SELECT id FROM acts WHERE label = 'connect'), 'a9000000-0000-4000-8000-000000000000', 'google') $$,
    '42501', NULL, 'authenticated: cannot call service_role workflow RPCs');

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000009ad","role":"authenticated","aal":"aal2"}';
INSERT INTO acts SELECT 'admin-connect', action_id FROM public.begin_privileged_action('b9000000-0000-4000-8000-000000000000', 'oauth.connect');
SELECT ok(EXISTS (SELECT 1 FROM acts WHERE label = 'admin-connect'), 'platform admin aal2: can start actions for any tenant');

RESET ROLE;
SELECT results_eq(
    $$ SELECT user_id, actor_role FROM public.audit_logs
       WHERE action = 'privileged_actions.insert' AND entity_id = (SELECT id FROM acts WHERE label = 'connect') $$,
    $$ VALUES ('00000000-0000-4000-8000-0000000009a2'::uuid, 'authenticated'::text) $$,
    'audit: starting a privileged action is recorded against the user');


-- =====================================================
-- Step 2: service_role RPCs consume the action
-- =====================================================
SET LOCAL ROLE service_role;
SET LOCAL request.jwt.claims TO '{"role":"service_role"}';

CREATE TEMP TABLE new_conn AS
SELECT public.create_oauth_connection((SELECT id FROM acts WHERE label = 'connect'),
                                      'a9000000-0000-4000-8000-000000000000', 'google') AS id;
SELECT ok((SELECT id IS NOT NULL FROM new_conn), 'service_role: creates a pending connection for an oauth.connect action');
SELECT throws_ok(
    format('SELECT public.create_oauth_connection(%L, %L, %L)',
           (SELECT id FROM acts WHERE label = 'connect'), 'a9000000-0000-4000-8000-000000000000', 'meta'),
    '42501', NULL, 'oauth.connect action cannot create a second connection');
SELECT throws_ok(
    format('SELECT public.store_oauth_tokens(%L, %L, %L, NULL, %L)',
           'a9000000-0000-4000-8000-0000000000c0', 'unbound-access', NULL, (SELECT id FROM acts WHERE label = 'expiring')),
    '42501', NULL, 'targetless oauth.connect action cannot authorize a connection-specific token write');

SELECT lives_ok(
    format('SELECT public.store_oauth_tokens(%L, %L, %L, NULL, %L)',
           (SELECT id FROM new_conn), 'g-access', 'g-refresh', (SELECT id FROM acts WHERE label = 'connect')),
    'service_role: stores tokens for the same oauth.connect action');
SELECT throws_ok(
    format('SELECT public.store_oauth_tokens(%L, %L, %L, NULL, %L)',
           'b9000000-0000-4000-8000-0000000000c0', 'cross-tenant-access', NULL, (SELECT id FROM acts WHERE label = 'connect')),
    '42501', NULL, 'oauth.connect action cannot access another tenant connection');

SELECT set_config('prisim.privileged_action_id', '', TRUE);  -- new request
SELECT lives_ok(format('SELECT public.store_oauth_tokens(%L, %L)', (SELECT id FROM new_conn), 'g-access-refreshed'),
    'service_role: background refresh needs no action');

SELECT set_config('prisim.privileged_action_id', '', TRUE);
CREATE TEMP TABLE new_job AS
SELECT public.start_sync_job((SELECT id FROM acts WHERE label = 'sync'), 'a9000000-0000-4000-8000-0000000000c0') AS id;
SELECT ok((SELECT id IS NOT NULL FROM new_job), 'service_role: queues a sync for a sync.start action');
SELECT throws_ok(format('SELECT public.start_sync_job(%L, %L)', (SELECT id FROM acts WHERE label = 'sync'), 'a9000000-0000-4000-8000-0000000000c0'),
    '55006', NULL, 'sync: a second queued job for the same connection is rejected');

-- Every mismatch is rejected
SELECT throws_ok(format('SELECT public.create_oauth_connection(%L, %L, %L)', (SELECT id FROM acts WHERE label = 'connect'), 'b9000000-0000-4000-8000-000000000000', 'google'),
    '42501', NULL, 'action cannot be used for another tenant');
SELECT throws_ok(format('SELECT public.create_oauth_connection(%L, %L, %L)', (SELECT id FROM acts WHERE label = 'sync'), 'a9000000-0000-4000-8000-000000000000', 'google'),
    '42501', NULL, 'action cannot be used for a different purpose');
SELECT throws_ok(format('SELECT public.start_sync_job(%L, %L)', (SELECT id FROM acts WHERE label = 'sync'), 'b9000000-0000-4000-8000-0000000000c0'),
    '42501', NULL, 'targeted action cannot be used for another connection');
SELECT throws_ok(format('SELECT public.delete_oauth_tokens(%L, %L)', (SELECT id FROM new_conn), (SELECT id FROM acts WHERE label = 'disconnect')),
    '42501', NULL, 'disconnect action is bound to its own connection');
SELECT throws_ok(format('SELECT public.create_oauth_connection(%L, %L, %L)', gen_random_uuid(), 'a9000000-0000-4000-8000-000000000000', 'google'),
    '42501', NULL, 'made-up action id is rejected');
SELECT throws_ok($$ SELECT * FROM private.privileged_actions $$,
    '42501', NULL, 'service_role: cannot read or forge privileged actions');

RESET ROLE;

-- Expired actions and initiators who lost their role are rejected.
UPDATE private.privileged_actions SET expires_at = NOW() - INTERVAL '1 minute'
WHERE id = (SELECT id FROM acts WHERE label = 'expiring');
UPDATE public.tenant_memberships SET role = 'client'
WHERE user_id = '00000000-0000-4000-8000-0000000009a2';

SET LOCAL ROLE service_role;
SELECT throws_ok(format('SELECT public.create_oauth_connection(%L, %L, %L)', (SELECT id FROM acts WHERE label = 'expiring'), 'a9000000-0000-4000-8000-000000000000', 'meta'),
    '42501', NULL, 'expired action is rejected');
SELECT throws_ok(format('SELECT public.delete_oauth_tokens(%L, %L)', 'a9000000-0000-4000-8000-0000000000c0', (SELECT id FROM acts WHERE label = 'disconnect')),
    '42501', NULL, 'action is rejected once the initiator is no longer manager+');

-- Platform-admin action
SELECT set_config('prisim.privileged_action_id', '', TRUE);
SELECT lives_ok(format('SELECT public.create_oauth_connection(%L, %L, %L)', (SELECT id FROM acts WHERE label = 'admin-connect'), 'b9000000-0000-4000-8000-000000000000', 'google'),
    'platform admin action: usable by service_role');

-- A binding never leaks into another tenant's rows in the same transaction.
UPDATE public.tenants SET business_name = 'Actions A (renamed)' WHERE id = 'a9000000-0000-4000-8000-000000000000';
SELECT set_config('prisim.privileged_action_id', 'not-a-uuid', TRUE);
UPDATE public.tenants SET business_name = 'Actions S (renamed)' WHERE id = 'c9000000-0000-4000-8000-000000000000';
RESET ROLE;


-- =====================================================
-- Step 3: the audit trail names the initiating user
-- =====================================================
SELECT results_eq(
    $$ SELECT user_id, actor_role, details ->> 'privileged_action_id' FROM public.audit_logs
       WHERE action = 'oauth_connections.insert' AND entity_id = (SELECT id FROM new_conn) $$,
    format($$ VALUES ('00000000-0000-4000-8000-0000000009a2'::uuid, 'service_role'::text, %L::text) $$,
           (SELECT id FROM acts WHERE label = 'connect')),
    'audit: connection creation attributed to the manager, executed by service_role');
SELECT results_eq(
    $$ SELECT user_id FROM public.audit_logs
       WHERE action = 'oauth_credentials.insert' AND entity_id = (SELECT id FROM new_conn) $$,
    $$ VALUES ('00000000-0000-4000-8000-0000000009a2'::uuid) $$,
    'audit: token storage attributed to the manager');
SELECT results_eq(
    $$ SELECT user_id, details ? 'privileged_action_id' FROM public.audit_logs
       WHERE action = 'oauth_credentials.update' AND entity_id = (SELECT id FROM new_conn) $$,
    $$ VALUES (NULL::uuid, FALSE) $$,
    'audit: background refresh is recorded as service_role only');
SELECT results_eq(
    $$ SELECT user_id FROM public.audit_logs
       WHERE action = 'sync_jobs.insert' AND entity_id = (SELECT id FROM new_job) $$,
    $$ VALUES ('00000000-0000-4000-8000-0000000009a2'::uuid) $$,
    'audit: manual sync attributed to the manager');
SELECT results_eq(
    $$ SELECT user_id FROM public.audit_logs
       WHERE action = 'oauth_connections.insert' AND tenant_id = 'b9000000-0000-4000-8000-000000000000' AND actor_role = 'service_role' $$,
    $$ VALUES ('00000000-0000-4000-8000-0000000009ad'::uuid) $$,
    'audit: platform-admin initiated work attributed to the platform admin');
SELECT results_eq(
    $$ SELECT user_id FROM public.audit_logs
       WHERE action = 'tenants.update' AND tenant_id = 'a9000000-0000-4000-8000-000000000000' $$,
    $$ VALUES (NULL::uuid) $$,
    'audit: a binding for tenant B is not applied to tenant A rows');
SELECT results_eq(
    $$ SELECT user_id FROM public.audit_logs
       WHERE action = 'tenants.update' AND tenant_id = 'c9000000-0000-4000-8000-000000000000' $$,
    $$ VALUES (NULL::uuid) $$,
    'audit: a malformed binding is ignored, not trusted');

SELECT * FROM finish();
ROLLBACK;
