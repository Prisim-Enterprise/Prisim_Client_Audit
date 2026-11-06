-- =====================================================
-- 07 - Catalog guards: function search_path and execute allowlists
-- Run locally with: npx supabase test db
-- These fail when a new function is added without the required hardening,
-- so every addition is a deliberate, reviewed change to this file.
-- =====================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT no_plan();

-- Functions we own in public/private (extension members excluded).
CREATE TEMP VIEW app_functions AS
SELECT p.oid, n.nspname, p.proname, p.prosecdef, p.proconfig,
       p.oid::regprocedure::text AS signature
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'private')
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e');

SELECT is_empty(
    $$ SELECT signature FROM app_functions
       WHERE prosecdef AND NOT COALESCE(proconfig @> ARRAY['search_path=""'], FALSE) $$,
    'every SECURITY DEFINER function pins search_path to an empty string');

SELECT is_empty(
    $$ SELECT signature FROM app_functions
       WHERE NOT COALESCE(proconfig @> ARRAY['search_path=""'], FALSE) $$,
    'every application function (definer or not) pins search_path');

SELECT is_empty(
    $$ SELECT signature FROM app_functions WHERE has_function_privilege('anon', oid, 'EXECUTE') $$,
    'anon can execute no application function');

SELECT is_empty(
    $$ SELECT signature FROM app_functions
       WHERE nspname = 'private' AND has_function_privilege('public', oid, 'EXECUTE') $$,
    'no private function is executable by PUBLIC');

-- Exact allowlist for signed-in users in the exposed schema.
SELECT results_eq(
    $$ SELECT signature FROM app_functions
       WHERE nspname = 'public' AND has_function_privilege('authenticated', oid, 'EXECUTE')
       ORDER BY 1 $$,
    $$ VALUES
        ('accept_invitation(text)'),
        ('begin_privileged_action(uuid,text,uuid)'),
        ('change_member_role(uuid,uuid,text)'),
        ('create_invitation(uuid,text,text)'),
        ('deactivate_member(uuid,uuid)'),
        ('get_my_context()'),
        ('get_tenant_sync_status(uuid)'),
        ('is_tenant_member(uuid)'),
        ('revoke_invitation(uuid)') $$,
    'authenticated can execute exactly the approved public functions');

-- Private helpers callable by authenticated (needed inside RLS policies).
SELECT results_eq(
    $$ SELECT signature FROM app_functions
       WHERE nspname = 'private' AND has_function_privilege('authenticated', oid, 'EXECUTE')
       ORDER BY 1 $$,
    $$ VALUES
        ('private.can_read_tenant_object(text)'),
        ('private.can_view_profile(uuid)'),
        ('private.has_tenant_role(uuid,text)'),
        ('private.is_listed_platform_admin()'),
        ('private.is_platform_admin()'),
        ('private.my_tenant_ids(text)'),
        ('private.tenant_role_rank(text)'),
        ('private.try_uuid(text)') $$,
    'authenticated can execute exactly the approved private helpers');

-- service_role-only RPCs
SELECT results_eq(
    $$ SELECT signature FROM app_functions
       WHERE nspname = 'public'
         AND has_function_privilege('service_role', oid, 'EXECUTE')
         AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
       ORDER BY 1 $$,
    $$ VALUES
        ('create_oauth_connection(uuid,uuid,text)'),
        ('delete_oauth_tokens(uuid,uuid)'),
        ('expire_stale_invitations()'),
        ('get_oauth_tokens(uuid)'),
        ('start_sync_job(uuid,uuid,text)'),
        ('store_oauth_tokens(uuid,text,text,timestamp with time zone,uuid)') $$,
    'service_role-only public functions are exactly the approved RPCs');

-- private.use_privileged_action binds identities; only definer RPCs may call it.
SELECT ok(NOT has_function_privilege('service_role',  'private.use_privileged_action(uuid,text,uuid,uuid)', 'EXECUTE'),
    'service_role cannot call use_privileged_action directly');
SELECT ok(NOT has_function_privilege('authenticated', 'private.use_privileged_action(uuid,text,uuid,uuid)', 'EXECUTE'),
    'authenticated cannot call use_privileged_action');
SELECT ok(NOT has_table_privilege('service_role', 'private.privileged_actions', 'SELECT, INSERT, UPDATE, DELETE'),
    'service_role cannot read or forge privileged actions');

-- The private schema is not exposed through the Data API.
SELECT ok(NOT has_schema_privilege('anon', 'private', 'USAGE'), 'anon has no usage on private');
SELECT ok(NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'private' AND c.relkind IN ('r', 'p', 'v', 'm')
          AND (has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
               OR has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE'))),
    'no table in private is accessible to anon or authenticated');

-- Every table in public has RLS and is not FORCE-bypassed by grants to anon.
SELECT is_empty(
    $$ SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
         AND has_table_privilege('authenticated', c.oid, 'TRUNCATE, REFERENCES, TRIGGER') $$,
    'authenticated has no TRUNCATE/REFERENCES/TRIGGER on any public table');

SELECT * FROM finish();
ROLLBACK;
