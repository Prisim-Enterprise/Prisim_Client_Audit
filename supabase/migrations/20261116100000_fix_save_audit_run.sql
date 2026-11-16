-- =====================================================
-- 20261116100000 - Fix public.save_audit_run
--
-- 20261111100000 read the findings with
--   jsonb_to_recordset(p_findings) WITH ORDINALITY AS f(<column definitions>)
-- which PostgreSQL rejects at run time ("WITH ORDINALITY cannot be used with
-- a column definition list"). PL/pgSQL checks statements only when they run,
-- so the migration applied cleanly but every call that stores findings fails.
-- Found by the isolated CI pgTAP run (10_audit_platform).
--
-- The fix moves the column definition list inside ROWS FROM (...). Behaviour,
-- signature, security (aal2 staff only), grants and ownership are unchanged
-- (CREATE OR REPLACE keeps them). No table, column or data changes.
-- =====================================================

CREATE OR REPLACE FUNCTION public.save_audit_run(p_tenant_id UUID, p_run JSONB, p_findings JSONB)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_id UUID;
BEGIN
    IF NOT private.is_platform_admin() THEN
        RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant_id) THEN
        RAISE EXCEPTION 'Unknown tenant' USING ERRCODE = '22023';
    END IF;
    IF p_run IS NULL OR jsonb_typeof(p_run) <> 'object'
       OR p_findings IS NULL OR jsonb_typeof(p_findings) <> 'array'
       OR jsonb_array_length(p_findings) > 500 THEN
        RAISE EXCEPTION 'Invalid audit payload' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.audit_runs (
        tenant_id, title, period_start, period_end, engine_version, overall_score,
        platform_scores, category_scores, kpis, summary, ad_account_ids, created_by)
    VALUES (
        p_tenant_id,
        p_run ->> 'title',
        (p_run ->> 'period_start')::DATE,
        (p_run ->> 'period_end')::DATE,
        p_run ->> 'engine_version',
        (p_run ->> 'overall_score')::NUMERIC,
        COALESCE(p_run -> 'platform_scores', '{}'::JSONB),
        COALESCE(p_run -> 'category_scores', '{}'::JSONB),
        COALESCE(p_run -> 'kpis', '{}'::JSONB),
        NULLIF(btrim(p_run ->> 'summary'), ''),
        COALESCE(ARRAY(SELECT x::UUID FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(p_run -> 'ad_account_ids') = 'array'
                 THEN p_run -> 'ad_account_ids' ELSE '[]'::JSONB END) AS x), '{}'),
        (SELECT auth.uid()))
    RETURNING id INTO v_id;

    IF EXISTS (
        SELECT 1 FROM unnest((SELECT r.ad_account_ids FROM public.audit_runs r WHERE r.id = v_id)) AS x(id)
        WHERE NOT EXISTS (SELECT 1 FROM public.ad_accounts a WHERE a.id = x.id AND a.tenant_id = p_tenant_id)
    ) THEN
        RAISE EXCEPTION 'Audit references an ad account of another tenant' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.audit_findings (
        tenant_id, audit_run_id, ad_account_id, campaign_id, rule_id, category, platform,
        severity, title, description, recommendation, evidence, estimated_impact,
        impact_currency, sort_order)
    SELECT p_tenant_id, v_id, f.ad_account_id, f.campaign_id, f.rule_id, f.category, f.platform,
           f.severity, f.title, f.description, f.recommendation,
           CASE WHEN jsonb_typeof(f.evidence) = 'object' THEN f.evidence ELSE '{}'::JSONB END,
           f.estimated_impact, f.impact_currency, f.ord::INTEGER
    FROM ROWS FROM (
        jsonb_to_recordset(p_findings) AS (
            ad_account_id UUID, campaign_id UUID, rule_id TEXT, category TEXT, platform TEXT,
            severity TEXT, title TEXT, description TEXT, recommendation TEXT, evidence JSONB,
            estimated_impact NUMERIC, impact_currency TEXT)
    ) WITH ORDINALITY AS f(
        ad_account_id, campaign_id, rule_id, category, platform,
        severity, title, description, recommendation, evidence,
        estimated_impact, impact_currency, ord);

    RETURN v_id;
END;
$$;
