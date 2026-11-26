-- =====================================================
-- 12 - Audit accuracy (20261126100000): campaigns.details,
-- ad_account_diagnostics (staff-only) and store_ad_account_diagnostics
-- Run locally with: npx supabase test db
-- =====================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT no_plan();

INSERT INTO auth.users (id, email, email_confirmed_at, aud, role) VALUES
    ('00000000-0000-4000-8000-00000000ad02', 'staff2@prisim.test', NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000000c1', 'owner@c.test',       NOW(), 'authenticated', 'authenticated');
INSERT INTO public.platform_admins (user_id) VALUES ('00000000-0000-4000-8000-00000000ad02');
INSERT INTO public.tenants (id, business_name, slug) VALUES
    ('c0000000-0000-4000-8000-000000000000', 'Tenant C', 'accuracy-tenant-c'),
    ('d0000000-0000-4000-8000-000000000000', 'Tenant D', 'accuracy-tenant-d');
INSERT INTO public.tenant_memberships (tenant_id, user_id, role) VALUES
    ('c0000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000000c1', 'owner');
INSERT INTO public.oauth_connections (id, tenant_id, provider, status) VALUES
    ('c0000000-0000-4000-8000-0000000000c0', 'c0000000-0000-4000-8000-000000000000', 'google', 'connected'),
    ('d0000000-0000-4000-8000-0000000000c0', 'd0000000-0000-4000-8000-000000000000', 'google', 'connected');
INSERT INTO public.ad_accounts (id, tenant_id, connection_id, provider, external_account_id, currency, sync_enabled) VALUES
    ('c0000000-0000-4000-8000-0000000000aa', 'c0000000-0000-4000-8000-000000000000', 'c0000000-0000-4000-8000-0000000000c0', 'google', '1111111111', 'INR', TRUE),
    ('d0000000-0000-4000-8000-0000000000aa', 'd0000000-0000-4000-8000-000000000000', 'd0000000-0000-4000-8000-0000000000c0', 'google', '2222222222', 'INR', TRUE);
INSERT INTO public.sync_jobs (id, tenant_id, connection_id, provider, job_type, status, started_at) VALUES
    ('c0000000-0000-4000-8000-0000000000f1', 'c0000000-0000-4000-8000-000000000000', 'c0000000-0000-4000-8000-0000000000c0', 'google', 'manual_sync', 'processing', NOW()),
    ('c0000000-0000-4000-8000-0000000000f2', 'c0000000-0000-4000-8000-000000000000', 'c0000000-0000-4000-8000-0000000000c0', 'google', 'manual_sync', 'completed', NOW());

-- Structure and privileges
SELECT has_column('public', 'campaigns', 'details', 'campaigns.details exists');
SELECT col_not_null('public', 'campaigns', 'details', 'campaigns.details is NOT NULL');
SELECT has_table('public', 'ad_account_diagnostics', 'ad_account_diagnostics exists');
SELECT has_column('public', 'daily_metrics', 'platform_metrics', 'daily_metrics.platform_metrics exists');
SELECT ok(has_column_privilege('authenticated', 'public.daily_metrics', 'platform_metrics', 'SELECT'), 'platform_metrics readable through RLS like other metric columns');
SELECT ok(NOT has_column_privilege('authenticated', 'public.daily_metrics', 'source_payload', 'SELECT'), 'source_payload stays hidden');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ad_account_diagnostics'::regclass), 'diagnostics table has RLS enabled');
SELECT ok(NOT has_table_privilege('authenticated', 'public.ad_account_diagnostics', 'INSERT, UPDATE, DELETE'), 'authenticated cannot write diagnostics');
SELECT ok(NOT has_function_privilege('authenticated', 'public.store_ad_account_diagnostics(uuid,uuid,jsonb)', 'EXECUTE'), 'authenticated cannot store diagnostics');
SELECT ok(has_function_privilege('service_role', 'public.store_ad_account_diagnostics(uuid,uuid,jsonb)', 'EXECUTE'), 'service_role can store diagnostics');

-- Service RPCs
SET LOCAL ROLE service_role;
SET LOCAL request.jwt.claims TO '{"role":"service_role"}';

SELECT is(
    public.ingest_ad_account_data(
        'c0000000-0000-4000-8000-0000000000f1', 'c0000000-0000-4000-8000-0000000000aa',
        '[{"external_id":"77","name":"App","status":"ENABLED","daily_budget":700,"details":{"primary_status":"NOT_ELIGIBLE","primary_status_reasons":["CAMPAIGN_PENDING"],"start":"2026-11-20 00:00:00"}},
          {"external_id":"78","name":"No details"}]'::JSONB,
        '[]'::JSONB) ->> 'campaigns',
    '2', 'ingest stores campaigns with and without details');
SELECT is((SELECT details ->> 'primary_status' FROM public.campaigns WHERE external_campaign_id = '77'), 'NOT_ELIGIBLE', 'details stored');
SELECT is((SELECT details FROM public.campaigns WHERE external_campaign_id = '78'), '{}'::JSONB, 'missing details stored as an empty object');

-- platform_metrics and placeholder campaigns (metrics of campaigns the platform no longer lists)
SELECT is(
    public.ingest_ad_account_data(
        'c0000000-0000-4000-8000-0000000000f1', 'c0000000-0000-4000-8000-0000000000aa',
        '[{"external_id":"77","placeholder":true},{"external_id":"99","placeholder":true}]'::JSONB,
        '[{"external_campaign_id":"77","date":"2026-11-01","impressions":10,"clicks":1,"spend":5,"platform_metrics":{"link_clicks":1,"leads":0}},
          {"external_campaign_id":"99","date":"2026-11-01","impressions":20,"clicks":2,"spend":6}]'::JSONB) ->> 'metrics',
    '2', 'metrics of unlisted campaigns are stored, not dropped');
SELECT is((SELECT campaign_name FROM public.campaigns WHERE external_campaign_id = '77'), 'App', 'a placeholder does not overwrite a known campaign');
SELECT is((SELECT campaign_status FROM public.campaigns WHERE external_campaign_id = '99'), 'UNKNOWN', 'a new placeholder campaign is created as UNKNOWN');
SELECT is(
    (SELECT platform_metrics ->> 'link_clicks' FROM public.daily_metrics m JOIN public.campaigns c ON c.id = m.campaign_id WHERE c.external_campaign_id = '77'),
    '1', 'platform_metrics stored');
SELECT ok(
    (SELECT platform_metrics IS NULL FROM public.daily_metrics m JOIN public.campaigns c ON c.id = m.campaign_id WHERE c.external_campaign_id = '99'),
    'absent platform_metrics stay NULL (not reported), not zero');

SELECT lives_ok(
    $$ SELECT public.store_ad_account_diagnostics('c0000000-0000-4000-8000-0000000000f1', 'c0000000-0000-4000-8000-0000000000aa',
         '{"provider":"google","window":{"since":"2026-10-26","until":"2026-11-24"},"captured_at":"2026-11-25T00:00:00Z","sections":{"conversion_actions":{"status":"ok","rows":[]}}}'::JSONB) $$,
    'diagnostics stored for a running job');
SELECT lives_ok(
    $$ SELECT public.store_ad_account_diagnostics('c0000000-0000-4000-8000-0000000000f1', 'c0000000-0000-4000-8000-0000000000aa',
         '{"provider":"google","window":{"since":"2026-10-27","until":"2026-11-25"},"sections":{}}'::JSONB) $$,
    'diagnostics replaced (one snapshot per account)');
SELECT is((SELECT count(*)::INT FROM public.ad_account_diagnostics WHERE ad_account_id = 'c0000000-0000-4000-8000-0000000000aa'), 1, 'one snapshot per account');
SELECT is((SELECT window_start FROM public.ad_account_diagnostics WHERE ad_account_id = 'c0000000-0000-4000-8000-0000000000aa'), '2026-10-27'::DATE, 'latest window kept');
SELECT throws_ok(
    $$ SELECT public.store_ad_account_diagnostics('c0000000-0000-4000-8000-0000000000f1', 'd0000000-0000-4000-8000-0000000000aa',
         '{"provider":"google","window":{"since":"2026-10-26","until":"2026-11-24"},"sections":{}}'::JSONB) $$,
    '22023', NULL, 'cannot store diagnostics for an account outside the job (other tenant)');
SELECT throws_ok(
    $$ SELECT public.store_ad_account_diagnostics('c0000000-0000-4000-8000-0000000000f2', 'c0000000-0000-4000-8000-0000000000aa',
         '{"provider":"google","window":{"since":"2026-10-26","until":"2026-11-24"},"sections":{}}'::JSONB) $$,
    '22023', NULL, 'cannot store diagnostics for a job that is not running');
SELECT throws_ok(
    $$ SELECT public.store_ad_account_diagnostics('c0000000-0000-4000-8000-0000000000f1', 'c0000000-0000-4000-8000-0000000000aa',
         '{"provider":"meta","window":{"since":"2026-10-26","until":"2026-11-24"},"sections":{}}'::JSONB) $$,
    '22023', NULL, 'provider must match the ad account');
SELECT throws_ok(
    $$ SELECT public.store_ad_account_diagnostics('c0000000-0000-4000-8000-0000000000f1', 'c0000000-0000-4000-8000-0000000000aa',
         '{"provider":"google","window":{"since":"2026-01-01","until":"2026-11-24"},"sections":{}}'::JSONB) $$,
    '22023', NULL, 'diagnostics window is bounded');

-- Read access: platform admins only
RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal2"}';
SELECT is((SELECT count(*)::INT FROM public.ad_account_diagnostics), 0, 'tenant owner cannot read diagnostics');
SELECT is((SELECT details ->> 'primary_status' FROM public.campaigns WHERE external_campaign_id = '77'), 'NOT_ELIGIBLE', 'tenant members read their own campaign details');

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-00000000ad02","role":"authenticated","aal":"aal2"}';
SELECT is((SELECT count(*)::INT FROM public.ad_account_diagnostics), 1, 'aal2 platform admin reads diagnostics');

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-00000000ad02","role":"authenticated","aal":"aal1"}';
SELECT is((SELECT count(*)::INT FROM public.ad_account_diagnostics), 0, 'platform admin without MFA reads nothing');

SELECT * FROM finish();
ROLLBACK;
