-- =====================================================
-- 01 - Structure, privileges and data integrity
-- Run locally with: npx supabase test db
-- Everything runs inside a transaction and is rolled back.
-- =====================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT no_plan();

-- -----------------------------------------------------
-- RLS coverage
-- -----------------------------------------------------
SELECT is_empty(
    $$ SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity $$,
    'RLS is enabled on every table in public'
);
SELECT ok(
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'private.oauth_credentials'::regclass),
    'RLS is enabled on private.oauth_credentials'
);

-- -----------------------------------------------------
-- anon has no access at all
-- -----------------------------------------------------
SELECT is_empty(
    $$ SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
         AND (has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
              OR has_any_column_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE')) $$,
    'anon has no table or column privileges in public'
);
SELECT is_empty(
    $$ SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE') $$,
    'no function in public is executable by anon (new functions must REVOKE ... FROM PUBLIC, anon)'
);
SELECT ok(NOT has_schema_privilege('anon', 'private', 'USAGE'), 'anon has no usage on schema private');

-- -----------------------------------------------------
-- Secrets are unreachable from API roles
-- -----------------------------------------------------
SELECT ok(NOT has_table_privilege('authenticated', 'private.oauth_credentials', 'SELECT'), 'authenticated cannot read private.oauth_credentials');
SELECT ok(NOT has_table_privilege('service_role',  'private.oauth_credentials', 'SELECT'), 'service_role cannot read private.oauth_credentials directly');
SELECT ok(NOT has_column_privilege('authenticated', 'public.oauth_connections', 'encrypted_access_token',  'SELECT'), 'legacy access token column hidden');
SELECT ok(NOT has_column_privilege('authenticated', 'public.oauth_connections', 'encrypted_refresh_token', 'SELECT'), 'legacy refresh token column hidden');
SELECT ok(NOT has_column_privilege('authenticated', 'public.tenant_invitations', 'token_hash', 'SELECT'), 'invitation token hash hidden');

SELECT ok(NOT has_function_privilege('authenticated', 'public.store_oauth_tokens(uuid, text, text, timestamptz, uuid)', 'EXECUTE'), 'authenticated cannot store tokens');
SELECT ok(NOT has_function_privilege('authenticated', 'public.get_oauth_tokens(uuid)', 'EXECUTE'), 'authenticated cannot read tokens');
SELECT ok(NOT has_function_privilege('authenticated', 'public.delete_oauth_tokens(uuid, uuid)', 'EXECUTE'), 'authenticated cannot delete tokens');
SELECT ok(has_function_privilege('service_role', 'public.get_oauth_tokens(uuid)', 'EXECUTE'), 'service_role can read tokens via RPC');

-- -----------------------------------------------------
-- Write restrictions
-- -----------------------------------------------------
SELECT ok(NOT has_table_privilege('authenticated', 'public.tenants', 'DELETE'), 'tenants cannot be deleted through the API');
SELECT ok(NOT has_table_privilege('authenticated', 'public.platform_admins', 'INSERT'), 'platform admins cannot be granted through the API');
SELECT ok(NOT has_table_privilege('authenticated', 'public.platform_admins', 'UPDATE, DELETE'), 'platform admins cannot be changed through the API');
SELECT ok(NOT has_table_privilege('service_role', 'public.platform_admins', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'), 'platform-admin bootstrap is not exposed to service_role');
SELECT ok(NOT has_column_privilege('authenticated', 'public.profiles', 'email', 'UPDATE'), 'profile email is read-only');
SELECT ok(has_column_privilege('authenticated', 'public.profiles', 'full_name', 'UPDATE'), 'profile full_name is updatable');
SELECT ok(NOT has_table_privilege('authenticated', 'public.audit_logs', 'INSERT'), 'authenticated cannot write audit logs');
SELECT ok(NOT has_table_privilege('service_role', 'public.audit_logs', 'UPDATE'), 'audit logs are append-only (no UPDATE)');
SELECT ok(NOT has_table_privilege('service_role', 'public.audit_logs', 'DELETE'), 'audit logs are append-only (no DELETE)');
SELECT ok(NOT has_table_privilege('service_role', 'public.audit_logs', 'INSERT'), 'audit logs are trigger-written only (service_role has no INSERT)');
SELECT ok(NOT has_table_privilege('authenticated', 'public.tenant_invitations', 'INSERT, UPDATE, DELETE'), 'invitations are changed only through RPCs');
SELECT ok(NOT has_function_privilege('authenticated', 'public.create_invitation(uuid,uuid,text,text,text)', 'EXECUTE'),
    'authenticated cannot call the raw-token invitation RPC');
SELECT ok(has_function_privilege('service_role', 'public.create_invitation(uuid,uuid,text,text,text)', 'EXECUTE'),
    'service_role can call the invitation hash-storage RPC');
SELECT ok(position('token' IN pg_get_function_result(
    'public.create_invitation(uuid,uuid,text,text,text)'::regprocedure)) = 0,
    'invitation RPC response does not contain a token field');
SELECT ok(NOT has_column_privilege('authenticated', 'public.daily_metrics', 'source_payload', 'SELECT'), 'daily_metrics.source_payload is hidden from the API');
SELECT ok(NOT has_table_privilege('authenticated', 'public.sync_logs', 'INSERT'), 'authenticated cannot write sync logs');

-- -----------------------------------------------------
-- Objects created by the hardening migration
-- -----------------------------------------------------
SELECT has_table('public', 'platform_admins', 'platform_admins exists');
SELECT has_table('public', 'tenant_invitations', 'tenant_invitations exists');
SELECT has_table('private', 'oauth_credentials', 'private.oauth_credentials exists');
SELECT has_trigger('auth', 'users', 'on_auth_user_created', 'profile trigger on auth.users');
SELECT has_trigger('public', 'platform_admins', 'protect_last_platform_admin', 'last platform administrator is protected');
SELECT is((SELECT public FROM storage.buckets WHERE id = 'reports'), FALSE, 'reports bucket exists and is private');
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'daily_metrics_account_campaign_date_key'), 'new daily_metrics unique key exists');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'daily_metrics_ad_account_id_campaign_id_metric_date_key'), 'old daily_metrics unique key removed');

-- -----------------------------------------------------
-- Integrity fixtures (as postgres)
-- -----------------------------------------------------
INSERT INTO auth.users (id, email, email_confirmed_at, aud, role, raw_user_meta_data) VALUES
    ('00000000-0000-4000-8000-0000000001a1', 'integrity@a.test', NOW(), 'authenticated', 'authenticated', '{"full_name":"Integrity User"}');

INSERT INTO public.tenants (id, business_name, slug) VALUES
    ('a1000000-0000-4000-8000-000000000000', 'Integrity A', 'integrity-a'),
    ('b1000000-0000-4000-8000-000000000000', 'Integrity B', 'integrity-b');

INSERT INTO public.ad_accounts (id, tenant_id, provider, external_account_id) VALUES
    ('a1000000-0000-4000-8000-0000000000aa', 'a1000000-0000-4000-8000-000000000000', 'meta', 'act_int_a');

-- Profiles
SELECT results_eq(
    $$ SELECT email, full_name FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000001a1' $$,
    $$ VALUES ('integrity@a.test'::text, 'Integrity User'::text) $$,
    'profile is created automatically for new auth users'
);
UPDATE auth.users SET email = 'renamed@a.test' WHERE id = '00000000-0000-4000-8000-0000000001a1';
SELECT is(
    (SELECT email FROM public.profiles WHERE id = '00000000-0000-4000-8000-0000000001a1'),
    'renamed@a.test',
    'profile e-mail follows auth.users e-mail changes'
);

-- updated_at trigger
UPDATE public.tenants SET updated_at = '2000-01-01' WHERE id = 'a1000000-0000-4000-8000-000000000000';
SELECT ok(
    (SELECT updated_at > '2001-01-01' FROM public.tenants WHERE id = 'a1000000-0000-4000-8000-000000000000'),
    'updated_at is maintained by trigger'
);

-- Cross-tenant references are rejected
SELECT throws_ok(
    $$ INSERT INTO public.campaigns (tenant_id, ad_account_id, external_campaign_id)
       VALUES ('b1000000-0000-4000-8000-000000000000', 'a1000000-0000-4000-8000-0000000000aa', 'cmp_x') $$,
    '23503', NULL,
    'campaign cannot reference an ad account from another tenant'
);
SELECT throws_ok(
    $$ INSERT INTO public.daily_metrics (tenant_id, ad_account_id, metric_date)
       VALUES ('b1000000-0000-4000-8000-000000000000', 'a1000000-0000-4000-8000-0000000000aa', '2026-11-01') $$,
    '23503', NULL,
    'daily metric cannot reference an ad account from another tenant'
);

-- Campaign-level metrics must use the campaign's own ad account.
INSERT INTO public.ad_accounts (id, tenant_id, provider, external_account_id) VALUES
    ('a1000000-0000-4000-8000-0000000000ab', 'a1000000-0000-4000-8000-000000000000', 'google', 'int-a-google');
INSERT INTO public.campaigns (id, tenant_id, ad_account_id, external_campaign_id) VALUES
    ('a1000000-0000-4000-8000-0000000000ca', 'a1000000-0000-4000-8000-000000000000', 'a1000000-0000-4000-8000-0000000000aa', 'cmp_int_a');
SELECT throws_ok(
    $$ INSERT INTO public.daily_metrics (tenant_id, ad_account_id, campaign_id, metric_date)
       VALUES ('a1000000-0000-4000-8000-000000000000', 'a1000000-0000-4000-8000-0000000000ab',
               'a1000000-0000-4000-8000-0000000000ca', '2026-11-01') $$,
    '23503', NULL,
    'campaign metric cannot point at a different ad account of the same tenant'
);
SELECT lives_ok(
    $$ INSERT INTO public.daily_metrics (tenant_id, ad_account_id, campaign_id, metric_date)
       VALUES ('a1000000-0000-4000-8000-000000000000', 'a1000000-0000-4000-8000-0000000000aa',
               'a1000000-0000-4000-8000-0000000000ca', '2026-11-01') $$,
    'campaign metric with the campaign''s own ad account is accepted'
);

-- Account-level metrics (campaign_id NULL) are unique per day
SELECT lives_ok(
    $$ INSERT INTO public.daily_metrics (tenant_id, ad_account_id, metric_date)
       VALUES ('a1000000-0000-4000-8000-000000000000', 'a1000000-0000-4000-8000-0000000000aa', '2026-11-01') $$,
    'first account-level metric row is accepted'
);
SELECT throws_ok(
    $$ INSERT INTO public.daily_metrics (tenant_id, ad_account_id, metric_date)
       VALUES ('a1000000-0000-4000-8000-000000000000', 'a1000000-0000-4000-8000-0000000000aa', '2026-11-01') $$,
    '23505', NULL,
    'duplicate account-level metric row is rejected'
);

-- CHECK constraints
SELECT throws_ok($$ INSERT INTO public.tenants (business_name, slug) VALUES ('Bad', 'Bad Slug') $$, '23514', NULL, 'invalid slug rejected');
SELECT throws_ok($$ INSERT INTO public.tenants (business_name, slug) VALUES ('   ', 'blank-name') $$, '23514', NULL, 'blank business name rejected');
SELECT throws_ok(
    $$ INSERT INTO public.audit_scores (tenant_id, score) VALUES ('a1000000-0000-4000-8000-000000000000', 150) $$,
    '23514', NULL, 'audit score above 100 rejected');
SELECT throws_ok(
    $$ INSERT INTO public.daily_metrics (tenant_id, ad_account_id, metric_date, spend)
       VALUES ('a1000000-0000-4000-8000-000000000000', 'a1000000-0000-4000-8000-0000000000aa', '2026-11-02', -1) $$,
    '23514', NULL, 'negative spend rejected');
SELECT throws_ok(
    $$ INSERT INTO public.oauth_connections (tenant_id, provider, encrypted_access_token)
       VALUES ('a1000000-0000-4000-8000-000000000000', 'meta', 'ciphertext') $$,
    '23514', NULL, 'tokens cannot be written to legacy public columns');
SELECT throws_ok(
    $$ INSERT INTO public.reports (tenant_id, report_name, storage_path)
       VALUES ('a1000000-0000-4000-8000-000000000000', 'Wrong folder', 'b1000000-0000-4000-8000-000000000000/r.pdf') $$,
    '23514', NULL, 'report file must live in the owning tenant folder');
SELECT lives_ok(
    $$ INSERT INTO public.reports (tenant_id, report_name, storage_path)
       VALUES ('a1000000-0000-4000-8000-000000000000', 'Right folder', 'a1000000-0000-4000-8000-000000000000/r.pdf') $$,
    'report file inside the tenant folder accepted');
SELECT throws_ok(
    $$ INSERT INTO public.sync_logs (tenant_id, level, message) VALUES ('a1000000-0000-4000-8000-000000000000', 'fatal', 'x') $$,
    '23514', NULL, 'unknown sync log level rejected');

-- Audit trail
INSERT INTO public.tenant_memberships (tenant_id, user_id, role)
VALUES ('a1000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000001a1', 'owner');
SELECT ok(
    EXISTS (SELECT 1 FROM public.audit_logs
            WHERE action = 'tenant_memberships.insert'
              AND tenant_id = 'a1000000-0000-4000-8000-000000000000'),
    'membership changes are written to the audit log'
);
SELECT lives_ok(
    $$ DELETE FROM public.tenants WHERE id = 'b1000000-0000-4000-8000-000000000000' $$,
    'deleting a tenant with audit history succeeds (audit rows are detached, not blocking)'
);

SELECT * FROM finish();
ROLLBACK;
