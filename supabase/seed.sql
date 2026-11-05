-- =====================================================
-- PRISIM CLIENT AUDIT PORTAL
-- LOCAL DEVELOPMENT SEED DATA
-- =====================================================
--
-- Runs automatically after migrations on `supabase db reset` (local stack only).
--
-- NEVER apply this file to the hosted project:
--   * do not run `supabase db push --remote --include-seed`
--   * do not paste it into the hosted SQL editor
--
-- It contains fictional demo businesses only. It creates no auth users,
-- passwords, tokens or secrets. Create local users through Studio
-- (http://127.0.0.1:54323 -> Authentication -> Add user), then link them with
-- the snippet at the bottom of this file.
-- =====================================================

-- Tenants -------------------------------------------------------------------
INSERT INTO public.tenants (id, business_name, slug, email, status) VALUES
    ('11111111-1111-4111-8111-111111111111', 'Acme Dental Clinic', 'acme-dental',    'owner@acme-dental.example',    'active'),
    ('22222222-2222-4222-8222-222222222222', 'Bluefin Realty',     'bluefin-realty', 'owner@bluefin-realty.example', 'active'),
    ('33333333-3333-4333-8333-333333333333', 'Dormant Traders',    'dormant-traders', NULL,                          'suspended')
ON CONFLICT (id) DO NOTHING;

-- Ad accounts (no OAuth connection: demo data only) -------------------------
INSERT INTO public.ad_accounts (id, tenant_id, provider, external_account_id, account_name, currency, timezone, status) VALUES
    ('a1111111-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'meta',   'act_100000001', 'Acme Dental - Meta',   'INR', 'Asia/Kolkata', 'active'),
    ('a1111111-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'google', '123-456-7890',  'Acme Dental - Google', 'INR', 'Asia/Kolkata', 'active'),
    ('a2222222-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'meta',   'act_200000001', 'Bluefin - Meta',       'INR', 'Asia/Kolkata', 'active')
ON CONFLICT (id) DO NOTHING;

-- Campaigns -----------------------------------------------------------------
INSERT INTO public.campaigns (id, tenant_id, ad_account_id, external_campaign_id, campaign_name, objective, campaign_status) VALUES
    ('c1111111-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'a1111111-0000-4000-8000-000000000001', '23850000000001', 'Teeth Whitening - Leads', 'OUTCOME_LEADS',     'ACTIVE'),
    ('c1111111-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'a1111111-0000-4000-8000-000000000001', '23850000000002', 'Brand Awareness',         'OUTCOME_AWARENESS', 'PAUSED'),
    ('c1111111-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'a1111111-0000-4000-8000-000000000002', '9000000001',     'Search - Dentist Near Me', 'SEARCH',           'ENABLED'),
    ('c2222222-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'a2222222-0000-4000-8000-000000000001', '23860000000001', 'Villa Listings - Traffic', 'OUTCOME_TRAFFIC',  'ACTIVE')
ON CONFLICT (id) DO NOTHING;

-- Daily metrics: 30 days of deterministic demo numbers per campaign ---------
INSERT INTO public.daily_metrics
    (tenant_id, ad_account_id, campaign_id, metric_date, impressions, reach, clicks, spend, conversions, currency)
SELECT
    c.tenant_id,
    c.ad_account_id,
    c.id,
    d::date,
    1000 + (n * 37 % 900),
    800  + (n * 29 % 600),
    20   + (n * 7  % 60),
    (500 + (n * 53 % 1500))::numeric(18, 4),
    (n % 6)::numeric(18, 4),
    'INR'
FROM public.campaigns c
CROSS JOIN LATERAL generate_series(CURRENT_DATE - 29, CURRENT_DATE, INTERVAL '1 day') AS d
CROSS JOIN LATERAL (SELECT (EXTRACT(DOY FROM d)::int + ascii(right(c.id::text, 1))) AS n) AS k
ON CONFLICT DO NOTHING;

-- Audit scores --------------------------------------------------------------
INSERT INTO public.audit_scores (tenant_id, audit_date, platform, score, findings, recommendations) VALUES
    ('11111111-1111-4111-8111-111111111111', CURRENT_DATE, 'meta', 72.50,
     '[{"code":"low_ctr","severity":"medium","message":"CTR below 1% on Brand Awareness"}]',
     '[{"code":"refresh_creatives","message":"Rotate creatives every 14 days"}]'),
    ('11111111-1111-4111-8111-111111111111', CURRENT_DATE, 'google', 81.00, '[]', '[]'),
    ('22222222-2222-4222-8222-222222222222', CURRENT_DATE, 'meta', 64.25,
     '[{"code":"no_conversion_tracking","severity":"high","message":"No conversion events recorded"}]',
     '[{"code":"install_pixel","message":"Install the Meta Pixel and Conversions API"}]');

-- -------------------------------------------------------------------------
-- Linking local users (run manually in local Studio SQL editor after
-- creating users in Authentication). Replace the e-mails as needed.
--
--   -- Make a PRISIM staff member a platform administrator (requires the
--   -- 20261105120000 hardening migration):
--   INSERT INTO public.platform_admins (user_id)
--   SELECT id FROM auth.users WHERE email = 'staff@prisim.local';
--
--   -- Give a client user access to Acme Dental:
--   INSERT INTO public.tenant_memberships (tenant_id, user_id, role, status)
--   SELECT '11111111-1111-4111-8111-111111111111', id, 'owner', 'active'
--   FROM auth.users WHERE email = 'client@acme.local';
-- -------------------------------------------------------------------------
