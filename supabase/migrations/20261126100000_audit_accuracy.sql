-- =====================================================
-- 20261126100000 - Audit accuracy: campaign context and account diagnostics
--
-- Supports audit engine prisim-audit-2.0.0:
--   1. public.campaigns.details: non-secret campaign context reported by the
--      platform at sync time (Google primary status and reasons, start/end,
--      shared budget id/flag, budget period; Meta configured status, start/
--      stop time, budget level). An empty object means "not reported".
--   2. public.ad_account_diagnostics: latest diagnostics snapshot per ad
--      account (Google conversion actions, ad review status and strength,
--      Search impression share, keyword Quality Score, search terms; Meta ad
--      set learning status and optimization goal, ad status, pixels).
--      Staff-only (platform admins read; writes only through the service
--      RPC below). Clients never read it directly.
--   3. public.daily_metrics.platform_metrics: platform-specific metrics per
--      campaign/day (Meta link clicks and results per family: purchases,
--      leads, registrations, app installs, landing page views, purchase
--      value). NULL = not captured (rows synced before this migration).
--   4. ingest_ad_account_data stores campaigns.details and
--      daily_metrics.platform_metrics (same signature, grants unchanged), and
--      stores placeholder campaigns (metrics of campaigns the platform no
--      longer lists) without overwriting an existing campaign row.
--   5. store_ad_account_diagnostics: service_role RPC, bound to a running
--      sync job exactly like ingest_ad_account_data.
--
-- No existing column, policy or grant is changed; one column grant is added
-- for the new daily_metrics column (same rule as the other metric columns).
-- Additive and reversible:
--   DROP FUNCTION public.store_ad_account_diagnostics(UUID, UUID, JSONB);
--   DROP TABLE public.ad_account_diagnostics;
--   ALTER TABLE public.campaigns DROP COLUMN details;
--   ALTER TABLE public.daily_metrics DROP COLUMN platform_metrics;
--   (and re-apply ingest_ad_account_data from 20261111100000)
-- =====================================================

ALTER TABLE public.campaigns
    ADD COLUMN details JSONB NOT NULL DEFAULT '{}'::JSONB,
    ADD CONSTRAINT campaigns_details_object CHECK (jsonb_typeof(details) = 'object'),
    ADD CONSTRAINT campaigns_details_size CHECK (pg_column_size(details) <= 8192);

ALTER TABLE public.daily_metrics
    ADD COLUMN platform_metrics JSONB,
    ADD CONSTRAINT daily_metrics_platform_metrics_object CHECK (platform_metrics IS NULL OR jsonb_typeof(platform_metrics) = 'object'),
    ADD CONSTRAINT daily_metrics_platform_metrics_size CHECK (platform_metrics IS NULL OR pg_column_size(platform_metrics) <= 2048);

-- daily_metrics uses column grants (source_payload stays hidden).
GRANT SELECT (platform_metrics) ON public.daily_metrics TO authenticated;

CREATE TABLE public.ad_account_diagnostics (
    ad_account_id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('meta', 'google')),
    job_id UUID REFERENCES public.sync_jobs(id) ON DELETE SET NULL,
    window_start DATE NOT NULL,
    window_end DATE NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ad_account_diagnostics_window CHECK (window_end >= window_start AND window_end - window_start <= 92),
    CONSTRAINT ad_account_diagnostics_size CHECK (pg_column_size(payload) <= 1048576),
    FOREIGN KEY (ad_account_id, tenant_id)
        REFERENCES public.ad_accounts (id, tenant_id) ON DELETE CASCADE
);
ALTER TABLE public.ad_account_diagnostics ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_ad_account_diagnostics_tenant ON public.ad_account_diagnostics (tenant_id);
CREATE INDEX idx_ad_account_diagnostics_job ON public.ad_account_diagnostics (job_id);

-- Internal operational data (search terms, conversion setup): staff only,
-- read-only through the API.
CREATE POLICY "Platform admins read ad account diagnostics" ON public.ad_account_diagnostics
FOR SELECT TO authenticated
USING ((SELECT private.is_platform_admin()));

REVOKE ALL ON public.ad_account_diagnostics FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ad_account_diagnostics TO authenticated;
GRANT ALL ON public.ad_account_diagnostics TO service_role;


-- Same behaviour as 20261111100000, plus campaigns.details,
-- daily_metrics.platform_metrics and placeholder campaigns.
CREATE OR REPLACE FUNCTION public.ingest_ad_account_data(
    p_job_id UUID, p_ad_account_id UUID, p_campaigns JSONB, p_metrics JSONB)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.sync_jobs%ROWTYPE;
    v_account public.ad_accounts%ROWTYPE;
    v_campaigns INTEGER;
    v_placeholders INTEGER;
    v_metrics INTEGER;
BEGIN
    SELECT * INTO v_job FROM public.sync_jobs j WHERE j.id = p_job_id;
    IF NOT FOUND OR v_job.status <> 'processing' THEN
        RAISE EXCEPTION 'Sync job is not running' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_account FROM public.ad_accounts a
    WHERE a.id = p_ad_account_id AND a.connection_id = v_job.connection_id AND a.tenant_id = v_job.tenant_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ad account does not belong to this sync' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(COALESCE(p_campaigns, 'null'::JSONB)) <> 'array'
       OR jsonb_typeof(COALESCE(p_metrics, 'null'::JSONB)) <> 'array'
       OR jsonb_array_length(p_campaigns) > 2000
       OR jsonb_array_length(p_metrics) > 20000 THEN
        RAISE EXCEPTION 'Invalid sync payload' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.campaigns AS c (
        tenant_id, ad_account_id, external_campaign_id, campaign_name, objective, campaign_status,
        daily_budget, bid_strategy, channel_type, details, last_synced_at)
    SELECT DISTINCT ON (x.external_id)
           v_account.tenant_id, v_account.id, x.external_id, left(x.name, 500), left(x.objective, 80),
           left(x.status, 40),
           CASE WHEN x.daily_budget >= 0 THEN x.daily_budget END,
           left(x.bid_strategy, 80), left(x.channel_type, 80),
           CASE WHEN jsonb_typeof(x.details) = 'object' AND pg_column_size(x.details) <= 8192
                THEN x.details ELSE '{}'::JSONB END,
           NOW()
    FROM jsonb_to_recordset(p_campaigns) AS x(
        external_id TEXT, name TEXT, objective TEXT, status TEXT, daily_budget NUMERIC,
        bid_strategy TEXT, channel_type TEXT, details JSONB, placeholder BOOLEAN)
    WHERE x.external_id IS NOT NULL AND btrim(x.external_id) <> '' AND NOT COALESCE(x.placeholder, FALSE)
    ON CONFLICT (ad_account_id, external_campaign_id) DO UPDATE
    SET campaign_name = EXCLUDED.campaign_name,
        objective = EXCLUDED.objective,
        campaign_status = EXCLUDED.campaign_status,
        daily_budget = EXCLUDED.daily_budget,
        bid_strategy = EXCLUDED.bid_strategy,
        channel_type = EXCLUDED.channel_type,
        details = EXCLUDED.details,
        last_synced_at = EXCLUDED.last_synced_at;
    GET DIAGNOSTICS v_campaigns = ROW_COUNT;

    -- Placeholders: campaigns with metrics that the platform no longer lists.
    -- An existing row (with its last known name and settings) is kept as is.
    INSERT INTO public.campaigns AS c (
        tenant_id, ad_account_id, external_campaign_id, campaign_status, details, last_synced_at)
    SELECT DISTINCT ON (x.external_id)
           v_account.tenant_id, v_account.id, x.external_id, 'UNKNOWN', '{"placeholder": true}'::JSONB, NOW()
    FROM jsonb_to_recordset(p_campaigns) AS x(external_id TEXT, placeholder BOOLEAN)
    WHERE x.external_id IS NOT NULL AND btrim(x.external_id) <> '' AND COALESCE(x.placeholder, FALSE)
    ON CONFLICT (ad_account_id, external_campaign_id) DO NOTHING;
    GET DIAGNOSTICS v_placeholders = ROW_COUNT;
    v_campaigns := v_campaigns + v_placeholders;

    INSERT INTO public.daily_metrics AS m (
        tenant_id, ad_account_id, campaign_id, metric_date, impressions, reach, clicks, spend,
        conversions, conversion_value, currency, platform_metrics)
    SELECT DISTINCT ON (cm.id, x.date)
           v_account.tenant_id, v_account.id, cm.id, x.date,
           GREATEST(COALESCE(x.impressions, 0), 0),
           GREATEST(COALESCE(x.reach, 0), 0),
           GREATEST(COALESCE(x.clicks, 0), 0),
           GREATEST(COALESCE(x.spend, 0), 0),
           GREATEST(COALESCE(x.conversions, 0), 0),
           GREATEST(COALESCE(x.conversion_value, 0), 0),
           v_account.currency,
           CASE WHEN jsonb_typeof(x.platform_metrics) = 'object' AND pg_column_size(x.platform_metrics) <= 2048
                THEN x.platform_metrics END
    FROM jsonb_to_recordset(p_metrics) AS x(
        external_campaign_id TEXT, date DATE, impressions BIGINT, reach BIGINT, clicks BIGINT,
        spend NUMERIC, conversions NUMERIC, conversion_value NUMERIC, platform_metrics JSONB)
    JOIN public.campaigns cm
      ON cm.ad_account_id = v_account.id AND cm.external_campaign_id = x.external_campaign_id
    WHERE x.date IS NOT NULL
    ORDER BY cm.id, x.date
    ON CONFLICT ON CONSTRAINT daily_metrics_account_campaign_date_key DO UPDATE
    SET impressions = EXCLUDED.impressions,
        reach = EXCLUDED.reach,
        clicks = EXCLUDED.clicks,
        spend = EXCLUDED.spend,
        conversions = EXCLUDED.conversions,
        conversion_value = EXCLUDED.conversion_value,
        currency = EXCLUDED.currency,
        platform_metrics = EXCLUDED.platform_metrics;
    GET DIAGNOSTICS v_metrics = ROW_COUNT;

    UPDATE public.ad_accounts SET last_synced_at = NOW() WHERE id = v_account.id;

    RETURN jsonb_build_object('campaigns', v_campaigns, 'metrics', v_metrics);
END;
$$;


-- Replace one ad account's diagnostics snapshot for a job in processing.
CREATE FUNCTION public.store_ad_account_diagnostics(
    p_job_id UUID, p_ad_account_id UUID, p_diagnostics JSONB)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.sync_jobs%ROWTYPE;
    v_account public.ad_accounts%ROWTYPE;
    v_start DATE;
    v_end DATE;
BEGIN
    SELECT * INTO v_job FROM public.sync_jobs j WHERE j.id = p_job_id;
    IF NOT FOUND OR v_job.status <> 'processing' THEN
        RAISE EXCEPTION 'Sync job is not running' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_account FROM public.ad_accounts a
    WHERE a.id = p_ad_account_id AND a.connection_id = v_job.connection_id AND a.tenant_id = v_job.tenant_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ad account does not belong to this sync' USING ERRCODE = '22023';
    END IF;
    IF p_diagnostics IS NULL OR jsonb_typeof(p_diagnostics) <> 'object'
       OR jsonb_typeof(p_diagnostics -> 'sections') IS DISTINCT FROM 'object'
       OR p_diagnostics ->> 'provider' IS DISTINCT FROM v_account.provider
       OR pg_column_size(p_diagnostics) > 1048576 THEN
        RAISE EXCEPTION 'Invalid diagnostics payload' USING ERRCODE = '22023';
    END IF;
    BEGIN
        v_start := (p_diagnostics #>> '{window,since}')::DATE;
        v_end := (p_diagnostics #>> '{window,until}')::DATE;
    EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'Invalid diagnostics window' USING ERRCODE = '22023';
    END;
    IF v_start IS NULL OR v_end IS NULL OR v_end < v_start OR v_end - v_start > 92 THEN
        RAISE EXCEPTION 'Invalid diagnostics window' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.ad_account_diagnostics AS d (
        ad_account_id, tenant_id, provider, job_id, window_start, window_end, captured_at, payload)
    VALUES (v_account.id, v_account.tenant_id, v_account.provider, v_job.id, v_start, v_end, NOW(), p_diagnostics)
    ON CONFLICT (ad_account_id) DO UPDATE
    SET job_id = EXCLUDED.job_id,
        window_start = EXCLUDED.window_start,
        window_end = EXCLUDED.window_end,
        captured_at = EXCLUDED.captured_at,
        payload = EXCLUDED.payload,
        updated_at = NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.store_ad_account_diagnostics(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_ad_account_diagnostics(UUID, UUID, JSONB) TO service_role;

COMMENT ON COLUMN public.campaigns.details IS
    'Non-secret campaign context reported by the platform at the last sync (status reasons, dates, budget sharing). Empty object = not reported.';
COMMENT ON TABLE public.ad_account_diagnostics IS
    'Latest diagnostics snapshot per ad account, written by sync-ad-data. Platform admins read only.';
COMMENT ON FUNCTION public.store_ad_account_diagnostics(UUID, UUID, JSONB) IS
    'service_role: store the diagnostics snapshot of an ad account for a running sync job.';
