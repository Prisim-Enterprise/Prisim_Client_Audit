-- =====================================================
-- 10 - Audit platform (20261111100000): analytics RPCs, audit review
-- workflow, report visibility, storage reads, sync service RPCs
-- Run locally with: npx supabase test db
--
--   Tenant A  a0000000-...-000000000000  owner a1, viewer a2, manager a3
--   Tenant B  b0000000-...-000000000000  owner b1
--   ...ad01   platform admin
-- =====================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT no_plan();

INSERT INTO auth.users (id, email, email_confirmed_at, aud, role) VALUES
    ('00000000-0000-4000-8000-00000000ad01', 'staff@prisim.test', NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000000a1', 'owner@a.test',      NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000000a2', 'viewer@a.test',     NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000000a3', 'manager@a.test',    NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000000b1', 'owner@b.test',      NOW(), 'authenticated', 'authenticated');
INSERT INTO public.platform_admins (user_id) VALUES ('00000000-0000-4000-8000-00000000ad01');
INSERT INTO public.tenants (id, business_name, slug) VALUES
    ('a0000000-0000-4000-8000-000000000000', 'Tenant A', 'audit-tenant-a'),
    ('b0000000-0000-4000-8000-000000000000', 'Tenant B', 'audit-tenant-b');
INSERT INTO public.tenant_memberships (tenant_id, user_id, role) VALUES
    ('a0000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000000a1', 'owner'),
    ('a0000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000000a2', 'viewer'),
    ('a0000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000000a3', 'manager'),
    ('b0000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000000b1', 'owner');
INSERT INTO public.oauth_connections (id, tenant_id, provider, status) VALUES
    ('a0000000-0000-4000-8000-0000000000c0', 'a0000000-0000-4000-8000-000000000000', 'meta', 'connected'),
    ('b0000000-0000-4000-8000-0000000000c0', 'b0000000-0000-4000-8000-000000000000', 'meta', 'connected');
INSERT INTO public.ad_accounts (id, tenant_id, connection_id, provider, external_account_id, currency, sync_enabled) VALUES
    ('a0000000-0000-4000-8000-0000000000aa', 'a0000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-0000000000c0', 'meta', 'act_a', 'INR', TRUE),
    ('a0000000-0000-4000-8000-0000000000ab', 'a0000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-0000000000c0', 'meta', 'act_a2', 'INR', FALSE),
    ('b0000000-0000-4000-8000-0000000000aa', 'b0000000-0000-4000-8000-000000000000', 'b0000000-0000-4000-8000-0000000000c0', 'meta', 'act_b', 'INR', TRUE);
INSERT INTO public.campaigns (id, tenant_id, ad_account_id, external_campaign_id, campaign_name) VALUES
    ('a0000000-0000-4000-8000-0000000000ca', 'a0000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-0000000000aa', 'cmp_a', 'A campaign'),
    ('b0000000-0000-4000-8000-0000000000ca', 'b0000000-0000-4000-8000-000000000000', 'b0000000-0000-4000-8000-0000000000aa', 'cmp_b', 'B campaign');
INSERT INTO public.daily_metrics (tenant_id, ad_account_id, campaign_id, metric_date, impressions, clicks, spend, conversions, conversion_value) VALUES
    ('a0000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-0000000000aa', 'a0000000-0000-4000-8000-0000000000ca', '2026-10-01', 1000, 10, 100, 2, 300),
    ('a0000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-0000000000aa', 'a0000000-0000-4000-8000-0000000000ca', '2026-10-02', 2000, 30, 150, 3, 0),
    -- account-level row: excluded from totals so nothing is double counted
    ('a0000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-0000000000aa', NULL,                                    '2026-10-01', 9999, 99, 999, 9, 0),
    ('b0000000-0000-4000-8000-000000000000', 'b0000000-0000-4000-8000-0000000000aa', 'b0000000-0000-4000-8000-0000000000ca', '2026-10-01', 500, 5, 50, 1, 0);

-- -----------------------------------------------------
-- Structure and privileges
-- -----------------------------------------------------
SELECT has_table('public', 'audit_runs', 'audit_runs exists');
SELECT has_table('public', 'audit_findings', 'audit_findings exists');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.audit_runs'::regclass), 'RLS on audit_runs');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.audit_findings'::regclass), 'RLS on audit_findings');
SELECT ok(has_column_privilege('authenticated', 'public.daily_metrics', 'conversion_value', 'SELECT'), 'conversion_value readable');
SELECT ok(NOT has_column_privilege('authenticated', 'public.daily_metrics', 'source_payload', 'SELECT'), 'source_payload still hidden');
SELECT ok(NOT has_function_privilege('authenticated', 'public.ingest_ad_account_data(uuid,uuid,jsonb,jsonb)', 'EXECUTE'), 'authenticated cannot ingest');
SELECT ok(NOT has_function_privilege('authenticated', 'public.claim_sync_job(uuid)', 'EXECUTE'), 'authenticated cannot claim jobs');
SELECT ok(NOT has_function_privilege('authenticated', 'public.upsert_discovered_ad_accounts(uuid,uuid,jsonb,text,text,text[])', 'EXECUTE'), 'authenticated cannot write discovered accounts');
SELECT ok(NOT has_function_privilege('anon', 'public.get_campaign_performance(uuid,date,date,uuid)', 'EXECUTE'), 'anon cannot read analytics');
SELECT ok(
    (SELECT NOT prosecdef FROM pg_proc WHERE oid = 'public.get_campaign_performance(uuid,date,date,uuid)'::regprocedure),
    'analytics RPC is SECURITY INVOKER (RLS applies)');
SELECT is(
    (SELECT count(*)::INT FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'reports: tenant members read own folder'),
    0, 'folder-wide member storage read was replaced');

-- -----------------------------------------------------
-- Analytics through RLS
-- -----------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}';

SELECT is(
    (SELECT spend FROM public.get_campaign_performance('a0000000-0000-4000-8000-000000000000', '2026-10-01', '2026-10-31')
     WHERE campaign_id = 'a0000000-0000-4000-8000-0000000000ca'),
    250::NUMERIC, 'campaign totals sum campaign-level rows only');
SELECT is(
    (SELECT sum(spend) FROM public.get_daily_performance('a0000000-0000-4000-8000-000000000000', '2026-10-01', '2026-10-31')),
    250::NUMERIC, 'daily totals exclude account-level rows');
SELECT is(
    (SELECT count(*)::INT FROM public.get_campaign_performance('b0000000-0000-4000-8000-000000000000', '2026-10-01', '2026-10-31')),
    0, 'viewer of A gets no rows for tenant B');
SELECT throws_ok(
    $$ SELECT * FROM public.get_tenant_members('a0000000-0000-4000-8000-000000000000') $$,
    '42501', NULL, 'viewer cannot list members');
SELECT throws_ok(
    $$ SELECT public.set_ad_account_sync('a0000000-0000-4000-8000-0000000000c0', ARRAY['a0000000-0000-4000-8000-0000000000ab']::UUID[]) $$,
    '42501', NULL, 'viewer cannot change account selection');
SELECT throws_ok($$ SELECT public.get_platform_overview() $$, '42501', NULL, 'tenant users cannot read platform overview');

-- Manager selects accounts; cross-connection ids are rejected.
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated"}';
SELECT is(
    public.set_ad_account_sync('a0000000-0000-4000-8000-0000000000c0', ARRAY['a0000000-0000-4000-8000-0000000000ab']::UUID[]),
    1, 'manager selects accounts');
SELECT throws_ok(
    $$ SELECT public.set_ad_account_sync('a0000000-0000-4000-8000-0000000000c0', ARRAY['b0000000-0000-4000-8000-0000000000aa']::UUID[]) $$,
    '22023', NULL, 'accounts of another tenant are rejected');
SELECT throws_ok(
    $$ SELECT public.set_ad_account_sync('b0000000-0000-4000-8000-0000000000c0', '{}'::UUID[]) $$,
    '42501', NULL, 'manager of A cannot change B');

-- Owner lists members.
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
SELECT is((SELECT count(*)::INT FROM public.get_tenant_members('a0000000-0000-4000-8000-000000000000')), 3, 'owner lists members');
SELECT throws_ok(
    $$ SELECT public.save_audit_run('a0000000-0000-4000-8000-000000000000', '{}'::JSONB, '[]'::JSONB) $$,
    '42501', NULL, 'tenant owner cannot save audits');

-- -----------------------------------------------------
-- Audit workflow (aal2 platform admin)
-- -----------------------------------------------------
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-00000000ad01","role":"authenticated","aal":"aal1"}';
SELECT throws_ok(
    $$ SELECT public.save_audit_run('a0000000-0000-4000-8000-000000000000', '{}'::JSONB, '[]'::JSONB) $$,
    '42501', NULL, 'aal1 staff session cannot save audits');

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-00000000ad01","role":"authenticated","aal":"aal2"}';
CREATE TEMP TABLE run_ids (id UUID) ON COMMIT DROP;
GRANT ALL ON run_ids TO authenticated;
INSERT INTO run_ids SELECT public.save_audit_run(
    'a0000000-0000-4000-8000-000000000000',
    jsonb_build_object(
        'title', 'October audit', 'period_start', '2026-10-01', 'period_end', '2026-10-31',
        'engine_version', 'test', 'overall_score', 72.5,
        'platform_scores', jsonb_build_object('meta', 70),
        'category_scores', jsonb_build_object('tracking', 100),
        'kpis', '{}'::JSONB, 'summary', 'Summary',
        'ad_account_ids', jsonb_build_array('a0000000-0000-4000-8000-0000000000aa')),
    jsonb_build_array(
        jsonb_build_object('ad_account_id', 'a0000000-0000-4000-8000-0000000000aa', 'campaign_id', 'a0000000-0000-4000-8000-0000000000ca',
                           'rule_id', 'efficiency.high_cpa_campaign', 'category', 'efficiency', 'platform', 'meta', 'severity', 'high',
                           'title', 'High CPA', 'description', 'd', 'recommendation', 'r', 'evidence', '{}'::JSONB),
        jsonb_build_object('rule_id', 'data_quality.missing_days', 'category', 'data_quality', 'severity', 'info',
                           'title', 'Gaps', 'description', 'd', 'recommendation', 'r')));
SELECT is((SELECT status FROM public.audit_runs WHERE id = (SELECT id FROM run_ids)), 'draft', 'saved as draft');
SELECT is((SELECT count(*)::INT FROM public.audit_findings WHERE audit_run_id = (SELECT id FROM run_ids)), 2, 'findings saved');
SELECT throws_ok(
    $$ SELECT public.save_audit_run('a0000000-0000-4000-8000-000000000000',
         jsonb_build_object('title', 'x', 'period_start', '2026-10-01', 'period_end', '2026-10-31', 'engine_version', 't',
                            'ad_account_ids', jsonb_build_array('b0000000-0000-4000-8000-0000000000aa')), '[]'::JSONB) $$,
    '22023', NULL, 'audits cannot reference another tenant''s accounts');
SELECT throws_ok(
    $$ UPDATE public.audit_runs SET status = 'published', published_at = NOW() WHERE id = (SELECT id FROM run_ids) $$,
    '42501', NULL, 'publishing bypassing the RPC is rejected');

UPDATE public.audit_findings SET status = 'dismissed', reviewer_note = 'False positive'
WHERE audit_run_id = (SELECT id FROM run_ids) AND rule_id = 'data_quality.missing_days';

-- Clients cannot see drafts.
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}';
SELECT is((SELECT count(*)::INT FROM public.audit_runs), 0, 'drafts are invisible to clients');
SELECT is((SELECT count(*)::INT FROM public.audit_findings), 0, 'draft findings are invisible to clients');

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-00000000ad01","role":"authenticated","aal":"aal2"}';
SELECT throws_ok(
    $$ SELECT public.set_audit_run_status((SELECT id FROM run_ids), 'archived') $$,
    '22023', NULL, 'drafts cannot be archived directly');
SELECT lives_ok($$ SELECT public.set_audit_run_status((SELECT id FROM run_ids), 'in_review') $$, 'submit for review');
SELECT lives_ok($$ SELECT public.set_audit_run_status((SELECT id FROM run_ids), 'published') $$, 'publish');
SELECT is((SELECT reviewed_by FROM public.audit_runs WHERE id = (SELECT id FROM run_ids)), '00000000-0000-4000-8000-00000000ad01'::UUID, 'reviewer recorded');
SELECT is((SELECT count(*)::INT FROM public.audit_scores WHERE audit_run_id = (SELECT id FROM run_ids)), 2, 'overall + meta scores written');
SELECT is(
    (SELECT jsonb_array_length(findings) FROM public.audit_scores WHERE audit_run_id = (SELECT id FROM run_ids) AND platform = 'overall'),
    1, 'dismissed findings excluded from score history');
SELECT throws_ok(
    $$ UPDATE public.audit_findings SET reviewer_note = 'late edit' WHERE audit_run_id = (SELECT id FROM run_ids) $$,
    '42501', NULL, 'published findings are immutable');
SELECT throws_ok(
    $$ UPDATE public.audit_runs SET summary = 'rewrite' WHERE id = (SELECT id FROM run_ids) $$,
    '42501', NULL, 'published audits are immutable');
SELECT throws_ok(
    $$ DELETE FROM public.audit_runs WHERE id = (SELECT id FROM run_ids) $$,
    '42501', NULL, 'published audits cannot be deleted');

-- Clients see the published audit without dismissed findings.
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}';
SELECT is((SELECT count(*)::INT FROM public.audit_runs), 1, 'client sees the published audit');
SELECT is((SELECT count(*)::INT FROM public.audit_findings), 1, 'client sees non-dismissed findings only');
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
SELECT is((SELECT count(*)::INT FROM public.audit_runs), 0, 'other tenants see nothing');

-- -----------------------------------------------------
-- Reports: visibility and storage
-- -----------------------------------------------------
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-00000000ad01","role":"authenticated","aal":"aal2"}';
INSERT INTO public.reports (id, tenant_id, audit_run_id, report_name, status, storage_path) VALUES
    ('a0000000-0000-4000-8000-0000000000f1', 'a0000000-0000-4000-8000-000000000000', (SELECT id FROM run_ids), 'Shared', 'ready', 'a0000000-0000-4000-8000-000000000000/shared.pdf'),
    ('a0000000-0000-4000-8000-0000000000f2', 'a0000000-0000-4000-8000-000000000000', NULL, 'Internal', 'ready', 'a0000000-0000-4000-8000-000000000000/internal.pdf');
SELECT throws_ok(
    $$ UPDATE public.reports SET visibility = 'client', status = 'generating' WHERE id = 'a0000000-0000-4000-8000-0000000000f2' $$,
    '23514', NULL, 'only ready reports can be shared');
UPDATE public.reports SET visibility = 'client' WHERE id = 'a0000000-0000-4000-8000-0000000000f1';
SELECT isnt((SELECT published_at FROM public.reports WHERE id = 'a0000000-0000-4000-8000-0000000000f1'), NULL, 'publication time stamped');
RESET ROLE;
INSERT INTO storage.objects (bucket_id, name) VALUES
    ('reports', 'a0000000-0000-4000-8000-000000000000/shared.pdf'),
    ('reports', 'a0000000-0000-4000-8000-000000000000/internal.pdf');
SET LOCAL ROLE authenticated;

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}';
SELECT is((SELECT count(*)::INT FROM public.reports), 1, 'client sees only the shared report');
SELECT is(
    (SELECT array_agg(name ORDER BY name) FROM storage.objects WHERE bucket_id = 'reports'),
    ARRAY['a0000000-0000-4000-8000-000000000000/shared.pdf']::TEXT[],
    'client can read only the shared report file');
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
SELECT is((SELECT count(*)::INT FROM storage.objects WHERE bucket_id = 'reports'), 0, 'other tenants read no files');

-- -----------------------------------------------------
-- Sync service RPCs
-- -----------------------------------------------------
RESET ROLE;
SET LOCAL ROLE service_role;
SET LOCAL request.jwt.claims TO '{"role":"service_role"}';
SELECT is(public.enqueue_scheduled_sync_jobs(), 2, 'daily jobs queued for connections with selected accounts');
SELECT is(public.enqueue_scheduled_sync_jobs(), 0, 'no duplicate jobs while pending');
CREATE TEMP TABLE claimed (job JSONB) ON COMMIT DROP;
INSERT INTO claimed
SELECT public.claim_sync_job(j.id) FROM public.sync_jobs j WHERE j.tenant_id = 'a0000000-0000-4000-8000-000000000000';
SELECT is((SELECT job ->> 'provider' FROM claimed), 'meta', 'job claimed');
SELECT is((SELECT jsonb_array_length(job -> 'accounts') FROM claimed), 2, 'claim returns selected accounts');
SELECT throws_ok(
    $$ SELECT public.ingest_ad_account_data((SELECT (job ->> 'job_id')::UUID FROM claimed), 'b0000000-0000-4000-8000-0000000000aa', '[]'::JSONB, '[]'::JSONB) $$,
    '22023', NULL, 'cannot ingest into an account outside the job');
SELECT is(
    public.ingest_ad_account_data(
        (SELECT (job ->> 'job_id')::UUID FROM claimed),
        'a0000000-0000-4000-8000-0000000000aa',
        '[{"external_id":"cmp_a","name":"Renamed"},{"external_id":"cmp_new","name":"New","daily_budget":500}]'::JSONB,
        '[{"external_campaign_id":"cmp_a","date":"2026-10-01","impressions":1200,"clicks":12,"spend":110,"conversions":2},
          {"external_campaign_id":"cmp_a","date":"2026-10-01","impressions":1300,"clicks":13,"spend":120,"conversions":2},
          {"external_campaign_id":"cmp_new","date":"2026-10-03","impressions":10,"clicks":1,"spend":5,"conversions":0},
          {"external_campaign_id":"unknown","date":"2026-10-03","impressions":10}]'::JSONB) ->> 'metrics',
    '2', 'ingest de-duplicates rows and skips unknown campaigns');
SELECT is((SELECT campaign_name FROM public.campaigns WHERE id = 'a0000000-0000-4000-8000-0000000000ca'), 'Renamed', 'campaign upserted');
SELECT is(
    (SELECT count(*)::INT FROM public.daily_metrics WHERE ad_account_id = 'a0000000-0000-4000-8000-0000000000aa' AND campaign_id IS NOT NULL AND metric_date = '2026-10-01'),
    1, 'existing day replaced, not duplicated');
SELECT lives_ok(
    $$ SELECT public.complete_sync_job((SELECT (job ->> 'job_id')::UUID FROM claimed), TRUE, NULL, '{"metrics":2}'::JSONB) $$,
    'job completed');
SELECT is((SELECT status FROM public.sync_jobs WHERE id = (SELECT (job ->> 'job_id')::UUID FROM claimed)), 'completed', 'status recorded');
SELECT throws_ok(
    $$ SELECT public.complete_sync_job((SELECT (job ->> 'job_id')::UUID FROM claimed), TRUE) $$,
    '22023', NULL, 'completed jobs cannot be completed twice');
SELECT throws_ok($$ SELECT public.set_connection_status('a0000000-0000-4000-8000-0000000000c0', 'revoked') $$, '22023', NULL, 'revocation needs the disconnect RPC');

-- Discovered accounts require the connection's bound oauth.connect action.
SELECT throws_ok(
    $$ SELECT public.upsert_discovered_ad_accounts(gen_random_uuid(), 'a0000000-0000-4000-8000-0000000000c0', '[]'::JSONB) $$,
    '42501', NULL, 'discovery without a privileged action is rejected');

SELECT * FROM finish();
ROLLBACK;
