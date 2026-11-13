-- =====================================================
-- PRISIM CLIENT AUDIT PORTAL
-- MIGRATION 20261111100000 - AUDIT PLATFORM
-- PostgreSQL 17 / Supabase
-- =====================================================
--
-- STATUS: Not applied to hosted. Requires 20261105120000_security_hardening.sql
-- first. Apply only with explicit owner approval (docs/production-rollout.md).
-- Once applied to hosted, never edit this file; add a new migration instead.
--
-- What this migration adds
--   1.  Client profile fields on tenants (industry, website, contact)
--   2.  Ad-account selection and sync bookkeeping (sync_enabled, metadata)
--   3.  Campaign attributes used by the audit engine (budget, bidding, channel)
--   4.  daily_metrics.conversion_value (ROAS) and updated_at
--   5.  audit_runs / audit_findings with a reviewed publication workflow
--   6.  Report visibility (internal -> client) bound to published audits
--   7.  Storage reads limited to client-visible, ready report files
--   8.  Analytics RPCs (SECURITY INVOKER, RLS applies)
--   9.  Tenant member listing, ad-account selection, audit save/publish RPCs
--   10. Service-role sync RPCs (claim, ingest, complete, schedule, discover)
--   11. Realtime publication for status-bearing tables
--
-- Security model is unchanged: RLS on every table, explicit grants, platform
-- admin privileges require aal2, service_role RPCs attribute work through
-- private.privileged_actions, audit_logs remain trigger-written.
-- Nothing is dropped except the two RLS policies replaced in sections 7/8.
-- =====================================================


-- -----------------------------------------------------
-- 1. TENANT PROFILE
-- -----------------------------------------------------
ALTER TABLE public.tenants
    ADD COLUMN industry TEXT,
    ADD COLUMN website TEXT,
    ADD COLUMN primary_contact_name TEXT,
    ADD CONSTRAINT tenants_industry_length CHECK (industry IS NULL OR char_length(industry) <= 120),
    ADD CONSTRAINT tenants_website_format CHECK (
        website IS NULL OR (char_length(website) <= 300 AND website ~ '^https?://[^[:space:]]+$')
    ),
    ADD CONSTRAINT tenants_contact_length CHECK (
        primary_contact_name IS NULL OR char_length(primary_contact_name) <= 160
    );


-- -----------------------------------------------------
-- 2. AD ACCOUNTS, CAMPAIGNS, METRICS
-- -----------------------------------------------------
ALTER TABLE public.ad_accounts
    ADD COLUMN sync_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN last_synced_at TIMESTAMPTZ,
    -- Non-secret provider context (e.g. Google login-customer-id).
    ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    ADD CONSTRAINT ad_accounts_metadata_object CHECK (jsonb_typeof(metadata) = 'object');

ALTER TABLE public.campaigns
    ADD COLUMN daily_budget NUMERIC(18, 4),
    ADD COLUMN bid_strategy TEXT,
    ADD COLUMN channel_type TEXT,
    ADD COLUMN last_synced_at TIMESTAMPTZ,
    ADD CONSTRAINT campaigns_daily_budget_non_negative CHECK (daily_budget IS NULL OR daily_budget >= 0);

ALTER TABLE public.daily_metrics
    ADD COLUMN conversion_value NUMERIC(18, 4) NOT NULL DEFAULT 0,
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD CONSTRAINT daily_metrics_conversion_value_non_negative CHECK (conversion_value >= 0);

ALTER TABLE public.sync_jobs
    ADD COLUMN stats JSONB NOT NULL DEFAULT '{}'::JSONB,
    ADD CONSTRAINT sync_jobs_stats_object CHECK (jsonb_typeof(stats) = 'object');

CREATE INDEX idx_ad_accounts_sync ON public.ad_accounts (connection_id) WHERE sync_enabled;
CREATE INDEX idx_campaigns_ad_account ON public.campaigns (ad_account_id);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.daily_metrics FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();


-- -----------------------------------------------------
-- 3. AUDIT RUNS AND FINDINGS
-- -----------------------------------------------------
-- An audit run is a frozen analysis of a tenant's ad data for a period,
-- computed by the audit engine (Edge Function run-audit) and reviewed by
-- PRISIM staff. Clients only see runs after publication. Synthetic/demo data
-- is never stored in the database.
CREATE TABLE public.audit_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (btrim(title) <> '' AND char_length(title) <= 200),
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'in_review', 'published', 'archived')),
    engine_version TEXT NOT NULL CHECK (char_length(engine_version) BETWEEN 1 AND 40),
    overall_score NUMERIC(5, 2) CHECK (overall_score IS NULL OR overall_score BETWEEN 0 AND 100),
    platform_scores JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(platform_scores) = 'object'),
    category_scores JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(category_scores) = 'object'),
    kpis JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(kpis) = 'object'),
    summary TEXT CHECK (summary IS NULL OR char_length(summary) <= 5000),
    ad_account_ids UUID[] NOT NULL DEFAULT '{}',
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT audit_runs_period_order CHECK (period_end >= period_start),
    CONSTRAINT audit_runs_period_length CHECK (period_end - period_start <= 366),
    CONSTRAINT audit_runs_published_stamp CHECK (
        status NOT IN ('published', 'archived') OR published_at IS NOT NULL
    ),
    CONSTRAINT audit_runs_id_tenant_key UNIQUE (id, tenant_id)
);
ALTER TABLE public.audit_runs ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_audit_runs_tenant ON public.audit_runs (tenant_id, created_at DESC);
CREATE INDEX idx_audit_runs_status ON public.audit_runs (status, created_at DESC);
CREATE INDEX idx_audit_runs_created_by ON public.audit_runs (created_by);
CREATE INDEX idx_audit_runs_reviewed_by ON public.audit_runs (reviewed_by);

CREATE TABLE public.audit_findings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    audit_run_id UUID NOT NULL,
    ad_account_id UUID,
    campaign_id UUID,
    rule_id TEXT NOT NULL CHECK (rule_id ~ '^[a-z0-9_.]{2,80}$'),
    category TEXT NOT NULL
        CHECK (category IN ('tracking', 'efficiency', 'structure', 'budget', 'engagement', 'trend', 'data_quality')),
    platform TEXT CHECK (platform IS NULL OR platform IN ('meta', 'google')),
    severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
    title TEXT NOT NULL CHECK (btrim(title) <> '' AND char_length(title) <= 240),
    description TEXT NOT NULL CHECK (char_length(description) <= 4000),
    recommendation TEXT NOT NULL CHECK (char_length(recommendation) <= 4000),
    evidence JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(evidence) = 'object'),
    estimated_impact NUMERIC(18, 4) CHECK (estimated_impact IS NULL OR estimated_impact >= 0),
    impact_currency TEXT CHECK (impact_currency IS NULL OR impact_currency ~ '^[A-Z]{3}$'),
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'accepted', 'dismissed', 'resolved')),
    -- Reviewer commentary. Client-visible once the run is published.
    reviewer_note TEXT CHECK (reviewer_note IS NULL OR char_length(reviewer_note) <= 2000),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (audit_run_id, tenant_id)
        REFERENCES public.audit_runs (id, tenant_id) ON DELETE CASCADE,
    FOREIGN KEY (ad_account_id, tenant_id)
        REFERENCES public.ad_accounts (id, tenant_id) ON DELETE SET NULL (ad_account_id),
    FOREIGN KEY (campaign_id, tenant_id)
        REFERENCES public.campaigns (id, tenant_id) ON DELETE SET NULL (campaign_id)
);
ALTER TABLE public.audit_findings ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_audit_findings_run ON public.audit_findings (audit_run_id, sort_order);
CREATE INDEX idx_audit_findings_tenant ON public.audit_findings (tenant_id);
CREATE INDEX idx_audit_findings_ad_account ON public.audit_findings (ad_account_id);
CREATE INDEX idx_audit_findings_campaign ON public.audit_findings (campaign_id);

-- Published scores keep a link to the run they summarize.
ALTER TABLE public.audit_scores
    ADD COLUMN audit_run_id UUID,
    ADD CONSTRAINT audit_scores_run_same_tenant_fkey
        FOREIGN KEY (audit_run_id, tenant_id)
        REFERENCES public.audit_runs (id, tenant_id) ON DELETE CASCADE;
CREATE INDEX idx_audit_scores_run ON public.audit_scores (audit_run_id);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.audit_runs     FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.audit_findings FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

-- Published audits are immutable. The only change allowed after publication
-- is published -> archived. Publication itself must go through
-- public.set_audit_run_status(), which records the reviewer and the scores.
CREATE FUNCTION private.guard_audit_run_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status IN ('published', 'archived')
           AND EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = OLD.tenant_id) THEN
            RAISE EXCEPTION 'Published audits cannot be deleted; archive them instead' USING ERRCODE = '42501';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'draft' THEN
            RAISE EXCEPTION 'New audits start as drafts' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id THEN
        RAISE EXCEPTION 'Audit identity cannot change' USING ERRCODE = '23514';
    END IF;

    IF OLD.status IN ('published', 'archived') THEN
        IF NOT (OLD.status = 'published' AND NEW.status = 'archived'
                AND (to_jsonb(NEW) - ARRAY['status', 'updated_at'])
                    = (to_jsonb(OLD) - ARRAY['status', 'updated_at'])) THEN
            RAISE EXCEPTION 'Published audits are immutable' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.status IN ('published', 'archived')
       AND COALESCE(current_setting('prisim.audit_publish', TRUE), '') <> NEW.id::TEXT THEN
        RAISE EXCEPTION 'Use set_audit_run_status to publish an audit' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_audit_run_change
BEFORE INSERT OR UPDATE OR DELETE ON public.audit_runs
FOR EACH ROW EXECUTE FUNCTION private.guard_audit_run_change();

-- Findings of a published or archived audit cannot be changed.
CREATE FUNCTION private.guard_audit_finding_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_status TEXT;
    v_run UUID := COALESCE(NEW.audit_run_id, OLD.audit_run_id);
BEGIN
    IF TG_OP = 'UPDATE' AND (NEW.audit_run_id <> OLD.audit_run_id OR NEW.tenant_id <> OLD.tenant_id) THEN
        RAISE EXCEPTION 'Findings cannot move between audits' USING ERRCODE = '23514';
    END IF;

    SELECT r.status INTO v_status FROM public.audit_runs r WHERE r.id = v_run;
    -- Cascades from deleting the run or tenant: nothing left to protect.
    IF NOT FOUND THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    IF v_status IN ('published', 'archived') THEN
        RAISE EXCEPTION 'Findings of a published audit are immutable' USING ERRCODE = '42501';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER guard_audit_finding_change
BEFORE INSERT OR UPDATE OR DELETE ON public.audit_findings
FOR EACH ROW EXECUTE FUNCTION private.guard_audit_finding_change();

CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE OR DELETE ON public.audit_runs     FOR EACH ROW EXECUTE FUNCTION private.audit_row_change();
-- Bulk inserts by the engine are summarized by the audit_runs entry.
CREATE TRIGGER audit_row_change AFTER UPDATE OR DELETE           ON public.audit_findings FOR EACH ROW EXECUTE FUNCTION private.audit_row_change();


-- -----------------------------------------------------
-- 4. REPORTS: VISIBILITY AND PROVENANCE
-- -----------------------------------------------------
ALTER TABLE public.reports
    ADD COLUMN audit_run_id UUID,
    ADD COLUMN visibility TEXT NOT NULL DEFAULT 'internal',
    ADD COLUMN file_size_bytes BIGINT,
    ADD COLUMN created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    ADD COLUMN error_message TEXT,
    ADD COLUMN published_at TIMESTAMPTZ,
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD CONSTRAINT reports_visibility_check CHECK (visibility IN ('internal', 'client')),
    ADD CONSTRAINT reports_client_visible_ready CHECK (
        visibility = 'internal' OR (status = 'ready' AND storage_path IS NOT NULL)
    ),
    ADD CONSTRAINT reports_file_size_non_negative CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
    ADD CONSTRAINT reports_error_message_length CHECK (error_message IS NULL OR char_length(error_message) <= 500),
    ADD CONSTRAINT reports_name_length CHECK (btrim(report_name) <> '' AND char_length(report_name) <= 200),
    ADD CONSTRAINT reports_audit_run_same_tenant_fkey
        FOREIGN KEY (audit_run_id, tenant_id)
        REFERENCES public.audit_runs (id, tenant_id) ON DELETE SET NULL (audit_run_id);
CREATE INDEX idx_reports_audit_run ON public.reports (audit_run_id);
CREATE INDEX idx_reports_created_by ON public.reports (created_by);
CREATE INDEX idx_reports_storage_path ON public.reports (storage_path) WHERE storage_path IS NOT NULL;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.reports FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

-- A report becomes client-visible only when ready and, if it belongs to an
-- audit, only after that audit is published. Publication time is stamped.
CREATE FUNCTION private.guard_report_visibility()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NEW.visibility = 'client' THEN
        IF NEW.audit_run_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.audit_runs r
            WHERE r.id = NEW.audit_run_id AND r.status = 'published') THEN
            RAISE EXCEPTION 'Publish the audit before sharing its report' USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'INSERT' OR OLD.visibility <> 'client' THEN
            NEW.published_at := NOW();
        END IF;
    ELSE
        NEW.published_at := NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_report_visibility
BEFORE INSERT OR UPDATE ON public.reports
FOR EACH ROW EXECUTE FUNCTION private.guard_report_visibility();


-- -----------------------------------------------------
-- 5. HELPERS
-- -----------------------------------------------------
-- Report files are readable by tenant members only when the matching report
-- row is ready and shared with the client. Staff (aal2) read everything.
CREATE FUNCTION private.can_read_report_object(p_object_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT private.is_platform_admin()
        OR EXISTS (
            SELECT 1
            FROM public.reports r
            WHERE r.storage_path = p_object_name
              AND r.visibility = 'client'
              AND r.status = 'ready'
              AND r.tenant_id = private.try_uuid(split_part(p_object_name, '/', 1))
              AND private.has_tenant_role(r.tenant_id, 'client')
        );
$$;

REVOKE ALL ON FUNCTION
    private.can_read_report_object(TEXT),
    private.guard_audit_run_change(),
    private.guard_audit_finding_change(),
    private.guard_report_visibility()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.can_read_report_object(TEXT) TO authenticated, service_role;


-- -----------------------------------------------------
-- 6. ROW LEVEL SECURITY
-- -----------------------------------------------------
CREATE POLICY "Platform admins manage audit runs" ON public.audit_runs
FOR ALL TO authenticated
USING ((SELECT private.is_platform_admin())) WITH CHECK ((SELECT private.is_platform_admin()));
CREATE POLICY "Members read published audit runs" ON public.audit_runs
FOR SELECT TO authenticated
USING (status = 'published' AND tenant_id IN (SELECT private.my_tenant_ids('client')));

CREATE POLICY "Platform admins manage audit findings" ON public.audit_findings
FOR ALL TO authenticated
USING ((SELECT private.is_platform_admin())) WITH CHECK ((SELECT private.is_platform_admin()));
CREATE POLICY "Members read published audit findings" ON public.audit_findings
FOR SELECT TO authenticated
USING (
    status <> 'dismissed'
    AND tenant_id IN (SELECT private.my_tenant_ids('client'))
    AND audit_run_id IN (
        SELECT r.id FROM public.audit_runs r
        WHERE r.status = 'published'
          AND r.tenant_id IN (SELECT private.my_tenant_ids('client'))
    )
);

-- Reports: clients see only finished reports PRISIM has shared with them.
DROP POLICY IF EXISTS "Members read reports" ON public.reports;
CREATE POLICY "Members read shared reports" ON public.reports
FOR SELECT TO authenticated
USING (
    visibility = 'client'
    AND status = 'ready'
    AND tenant_id IN (SELECT private.my_tenant_ids('client'))
);


-- -----------------------------------------------------
-- 7. STORAGE
-- -----------------------------------------------------
-- Replaces the folder-wide member read from 20261105120000: internal drafts
-- in the tenant folder are no longer downloadable by tenant members.
DROP POLICY IF EXISTS "reports: tenant members read own folder" ON storage.objects;
CREATE POLICY "reports: members read shared report files" ON storage.objects
FOR SELECT TO authenticated
USING (bucket_id = 'reports' AND private.can_read_report_object(name));


-- -----------------------------------------------------
-- 8. ANALYTICS RPCs (SECURITY INVOKER: the caller's RLS applies)
-- -----------------------------------------------------
-- Campaign-level rows are the source of truth for totals; account-level rows
-- (campaign_id NULL) are excluded so nothing is counted twice.
CREATE FUNCTION public.get_campaign_performance(
    p_tenant_id UUID, p_from DATE, p_to DATE, p_ad_account_id UUID DEFAULT NULL)
RETURNS TABLE (
    campaign_id UUID,
    ad_account_id UUID,
    provider TEXT,
    account_name TEXT,
    external_campaign_id TEXT,
    campaign_name TEXT,
    objective TEXT,
    campaign_status TEXT,
    channel_type TEXT,
    bid_strategy TEXT,
    daily_budget NUMERIC,
    currency TEXT,
    impressions BIGINT,
    reach BIGINT,
    clicks BIGINT,
    spend NUMERIC,
    conversions NUMERIC,
    conversion_value NUMERIC,
    active_days INTEGER
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT c.id, c.ad_account_id, a.provider, a.account_name, c.external_campaign_id, c.campaign_name,
           c.objective, c.campaign_status, c.channel_type, c.bid_strategy, c.daily_budget, a.currency,
           COALESCE(sum(m.impressions), 0)::BIGINT,
           COALESCE(sum(m.reach), 0)::BIGINT,
           COALESCE(sum(m.clicks), 0)::BIGINT,
           COALESCE(sum(m.spend), 0)::NUMERIC,
           COALESCE(sum(m.conversions), 0)::NUMERIC,
           COALESCE(sum(m.conversion_value), 0)::NUMERIC,
           (count(m.id) FILTER (WHERE m.impressions > 0 OR m.spend > 0))::INTEGER
    FROM public.campaigns c
    JOIN public.ad_accounts a ON a.id = c.ad_account_id
    LEFT JOIN public.daily_metrics m
           ON m.campaign_id = c.id
          AND m.metric_date BETWEEN p_from AND p_to
    WHERE c.tenant_id = p_tenant_id
      AND (p_ad_account_id IS NULL OR c.ad_account_id = p_ad_account_id)
      AND p_to >= p_from
      AND p_to - p_from <= 731
    GROUP BY c.id, a.id
    ORDER BY COALESCE(sum(m.spend), 0) DESC, c.campaign_name;
$$;

CREATE FUNCTION public.get_daily_performance(
    p_tenant_id UUID, p_from DATE, p_to DATE, p_ad_account_id UUID DEFAULT NULL)
RETURNS TABLE (
    metric_date DATE,
    ad_account_id UUID,
    provider TEXT,
    currency TEXT,
    impressions BIGINT,
    reach BIGINT,
    clicks BIGINT,
    spend NUMERIC,
    conversions NUMERIC,
    conversion_value NUMERIC
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT m.metric_date, m.ad_account_id, a.provider, a.currency,
           sum(m.impressions)::BIGINT, sum(m.reach)::BIGINT, sum(m.clicks)::BIGINT,
           sum(m.spend)::NUMERIC, sum(m.conversions)::NUMERIC, sum(m.conversion_value)::NUMERIC
    FROM public.daily_metrics m
    JOIN public.ad_accounts a ON a.id = m.ad_account_id
    WHERE m.tenant_id = p_tenant_id
      AND m.campaign_id IS NOT NULL
      AND m.metric_date BETWEEN p_from AND p_to
      AND (p_ad_account_id IS NULL OR m.ad_account_id = p_ad_account_id)
      AND p_to >= p_from
      AND p_to - p_from <= 731
    GROUP BY m.metric_date, m.ad_account_id, a.provider, a.currency
    ORDER BY m.metric_date, m.ad_account_id;
$$;


-- -----------------------------------------------------
-- 9. AUTHENTICATED RPCs (SECURITY DEFINER, authorize in SQL)
-- -----------------------------------------------------

-- Tenant member directory: owners/admins of the tenant or aal2 staff.
CREATE FUNCTION public.get_tenant_members(p_tenant_id UUID)
RETURNS TABLE (
    user_id UUID, email TEXT, full_name TEXT, role TEXT, status TEXT,
    created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT (private.is_platform_admin() OR private.has_tenant_role(p_tenant_id, 'admin')) THEN
        RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT tm.user_id, p.email, p.full_name, tm.role, tm.status, tm.created_at, tm.updated_at
    FROM public.tenant_memberships tm
    LEFT JOIN public.profiles p ON p.id = tm.user_id
    WHERE tm.tenant_id = p_tenant_id
    ORDER BY private.tenant_role_rank(tm.role) DESC, p.email;
END;
$$;

-- Choose which discovered ad accounts of a connection are synced and audited.
-- Managers+ of the tenant or aal2 staff. Returns the number selected.
CREATE FUNCTION public.set_ad_account_sync(p_connection_id UUID, p_ad_account_ids UUID[])
RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_tenant UUID;
    v_ids UUID[] := COALESCE(p_ad_account_ids, '{}');
BEGIN
    SELECT c.tenant_id INTO v_tenant FROM public.oauth_connections c WHERE c.id = p_connection_id;
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'Unknown connection' USING ERRCODE = '22023';
    END IF;
    IF NOT (private.is_platform_admin() OR private.has_tenant_role(v_tenant, 'manager')) THEN
        RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
    END IF;
    IF cardinality(v_ids) > 200 THEN
        RAISE EXCEPTION 'Too many accounts' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
        SELECT 1 FROM unnest(v_ids) AS x(id)
        WHERE NOT EXISTS (
            SELECT 1 FROM public.ad_accounts a
            WHERE a.id = x.id AND a.connection_id = p_connection_id AND a.tenant_id = v_tenant)
    ) THEN
        RAISE EXCEPTION 'Account does not belong to this connection' USING ERRCODE = '22023';
    END IF;

    UPDATE public.ad_accounts a
    SET sync_enabled = (a.id = ANY (v_ids))
    WHERE a.connection_id = p_connection_id
      AND a.tenant_id = v_tenant
      AND a.sync_enabled IS DISTINCT FROM (a.id = ANY (v_ids));

    RETURN (SELECT count(*) FROM public.ad_accounts a
            WHERE a.connection_id = p_connection_id AND a.sync_enabled)::INTEGER;
END;
$$;

-- Store an engine result as a draft audit. aal2 staff only; the caller's JWT
-- is the audit actor. Findings are validated by table constraints and the
-- same-tenant foreign keys.
CREATE FUNCTION public.save_audit_run(p_tenant_id UUID, p_run JSONB, p_findings JSONB)
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
    FROM jsonb_to_recordset(p_findings) WITH ORDINALITY AS f(
        ad_account_id UUID, campaign_id UUID, rule_id TEXT, category TEXT, platform TEXT,
        severity TEXT, title TEXT, description TEXT, recommendation TEXT, evidence JSONB,
        estimated_impact NUMERIC, impact_currency TEXT, ord BIGINT);

    RETURN v_id;
END;
$$;

-- Review workflow. aal2 staff only.
--   draft <-> in_review, draft|in_review -> published, published -> archived
-- Publishing stamps the reviewer and writes audit_scores rows for history.
CREATE FUNCTION public.set_audit_run_status(p_run_id UUID, p_status TEXT, p_summary TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_run public.audit_runs%ROWTYPE;
    v_uid UUID := (SELECT auth.uid());
    v_platform TEXT;
BEGIN
    IF NOT private.is_platform_admin() THEN
        RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_run FROM public.audit_runs r WHERE r.id = p_run_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown audit' USING ERRCODE = '22023';
    END IF;

    IF NOT (
           (v_run.status = 'draft'     AND p_status IN ('in_review', 'published'))
        OR (v_run.status = 'in_review' AND p_status IN ('draft', 'published'))
        OR (v_run.status = 'published' AND p_status = 'archived')
    ) THEN
        RAISE EXCEPTION 'Audit cannot move from % to %', v_run.status, p_status USING ERRCODE = '22023';
    END IF;

    IF p_summary IS NOT NULL AND v_run.status IN ('draft', 'in_review') THEN
        IF char_length(p_summary) > 5000 THEN
            RAISE EXCEPTION 'Summary is too long' USING ERRCODE = '22023';
        END IF;
        UPDATE public.audit_runs SET summary = NULLIF(btrim(p_summary), '') WHERE id = p_run_id;
    END IF;

    IF p_status = 'published' THEN
        PERFORM set_config('prisim.audit_publish', p_run_id::TEXT, TRUE);
        UPDATE public.audit_runs
        SET status = 'published', reviewed_by = v_uid, reviewed_at = NOW(), published_at = NOW()
        WHERE id = p_run_id;

        INSERT INTO public.audit_scores (tenant_id, audit_run_id, audit_date, platform, score, findings, recommendations)
        SELECT v_run.tenant_id, p_run_id, v_run.period_end, 'overall', v_run.overall_score,
               COALESCE(jsonb_agg(jsonb_build_object('severity', f.severity, 'title', f.title)
                        ORDER BY f.sort_order) FILTER (WHERE f.id IS NOT NULL), '[]'::JSONB),
               COALESCE(jsonb_agg(f.recommendation ORDER BY f.sort_order) FILTER (WHERE f.id IS NOT NULL), '[]'::JSONB)
        FROM (SELECT 1) AS one
        LEFT JOIN public.audit_findings f ON f.audit_run_id = p_run_id AND f.status <> 'dismissed';

        FOR v_platform IN SELECT k FROM jsonb_object_keys(v_run.platform_scores) AS k WHERE k IN ('meta', 'google') LOOP
            INSERT INTO public.audit_scores (tenant_id, audit_run_id, audit_date, platform, score, findings, recommendations)
            SELECT v_run.tenant_id, p_run_id, v_run.period_end, v_platform,
                   LEAST(GREATEST((v_run.platform_scores ->> v_platform)::NUMERIC, 0), 100),
                   COALESCE(jsonb_agg(jsonb_build_object('severity', f.severity, 'title', f.title)
                            ORDER BY f.sort_order) FILTER (WHERE f.id IS NOT NULL), '[]'::JSONB),
                   COALESCE(jsonb_agg(f.recommendation ORDER BY f.sort_order) FILTER (WHERE f.id IS NOT NULL), '[]'::JSONB)
            FROM (SELECT 1) AS one
            LEFT JOIN public.audit_findings f
                   ON f.audit_run_id = p_run_id AND f.status <> 'dismissed' AND f.platform = v_platform;
        END LOOP;
    ELSIF p_status = 'archived' THEN
        UPDATE public.audit_runs SET status = 'archived' WHERE id = p_run_id;
    ELSE
        UPDATE public.audit_runs SET status = p_status WHERE id = p_run_id;
    END IF;
END;
$$;

-- Staff dashboard counters. aal2 staff only.
CREATE FUNCTION public.get_platform_overview()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT private.is_platform_admin() THEN
        RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
    END IF;
    RETURN jsonb_build_object(
        'tenants', (SELECT jsonb_build_object(
            'total', count(*),
            'active', count(*) FILTER (WHERE t.status = 'active'),
            'inactive', count(*) FILTER (WHERE t.status = 'inactive'),
            'suspended', count(*) FILTER (WHERE t.status = 'suspended'))
            FROM public.tenants t),
        'connections', (SELECT jsonb_build_object(
            'total', count(*),
            'connected', count(*) FILTER (WHERE c.status = 'connected'),
            'attention', count(*) FILTER (WHERE c.status IN ('expired', 'error')))
            FROM public.oauth_connections c),
        'ad_accounts', (SELECT jsonb_build_object(
            'total', count(*),
            'syncing', count(*) FILTER (WHERE a.sync_enabled))
            FROM public.ad_accounts a),
        'audits', (SELECT jsonb_build_object(
            'draft', count(*) FILTER (WHERE r.status = 'draft'),
            'in_review', count(*) FILTER (WHERE r.status = 'in_review'),
            'published', count(*) FILTER (WHERE r.status = 'published'))
            FROM public.audit_runs r),
        'reports', (SELECT jsonb_build_object(
            'ready', count(*) FILTER (WHERE rp.status = 'ready'),
            'shared', count(*) FILTER (WHERE rp.visibility = 'client'),
            'failed', count(*) FILTER (WHERE rp.status = 'failed'))
            FROM public.reports rp),
        'sync', (SELECT jsonb_build_object(
            'running', count(*) FILTER (WHERE j.status IN ('pending', 'processing')),
            'failed_7d', count(*) FILTER (WHERE j.status = 'failed' AND j.created_at > NOW() - INTERVAL '7 days'),
            'last_completed_at', max(j.completed_at) FILTER (WHERE j.status = 'completed'))
            FROM public.sync_jobs j)
    );
END;
$$;


-- -----------------------------------------------------
-- 10. SERVICE-ROLE RPCs (Edge Functions only)
-- -----------------------------------------------------

-- OAuth callback: record the ad accounts discovered for a new connection.
-- Requires the connection's bound oauth.connect action (actor attribution).
CREATE FUNCTION public.upsert_discovered_ad_accounts(
    p_action_id UUID,
    p_connection_id UUID,
    p_accounts JSONB,
    p_provider_account_id TEXT DEFAULT NULL,
    p_account_name TEXT DEFAULT NULL,
    p_scopes TEXT[] DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_conn public.oauth_connections%ROWTYPE;
    v_count INTEGER;
BEGIN
    SELECT * INTO v_conn FROM public.oauth_connections c WHERE c.id = p_connection_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown OAuth connection' USING ERRCODE = '22023';
    END IF;
    PERFORM private.use_privileged_action(p_action_id, 'oauth.connect', v_conn.tenant_id, p_connection_id);

    IF p_accounts IS NULL OR jsonb_typeof(p_accounts) <> 'array' OR jsonb_array_length(p_accounts) > 500 THEN
        RAISE EXCEPTION 'Invalid account list' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.ad_accounts AS a (
        tenant_id, connection_id, provider, external_account_id, account_name, currency, timezone, status, metadata)
    SELECT DISTINCT ON (x.external_account_id)
           v_conn.tenant_id, p_connection_id, v_conn.provider, x.external_account_id,
           left(x.account_name, 300),
           CASE WHEN upper(x.currency) ~ '^[A-Z]{3}$' THEN upper(x.currency) END,
           left(x.timezone, 80),
           CASE WHEN x.status IN ('active', 'paused', 'disabled', 'closed', 'unknown') THEN x.status ELSE 'unknown' END,
           CASE WHEN jsonb_typeof(x.metadata) = 'object' THEN x.metadata ELSE '{}'::JSONB END
    FROM jsonb_to_recordset(p_accounts) AS x(
        external_account_id TEXT, account_name TEXT, currency TEXT, timezone TEXT, status TEXT, metadata JSONB)
    WHERE x.external_account_id IS NOT NULL AND btrim(x.external_account_id) <> ''
    ON CONFLICT (tenant_id, provider, external_account_id) DO UPDATE
    SET connection_id = EXCLUDED.connection_id,
        account_name = EXCLUDED.account_name,
        currency = EXCLUDED.currency,
        timezone = EXCLUDED.timezone,
        status = EXCLUDED.status,
        metadata = EXCLUDED.metadata;
    GET DIAGNOSTICS v_count = ROW_COUNT;

    UPDATE public.oauth_connections
    SET provider_account_id = COALESCE(left(p_provider_account_id, 120), provider_account_id),
        account_name = COALESCE(left(p_account_name, 300), account_name),
        scopes = COALESCE(p_scopes, scopes)
    WHERE id = p_connection_id;

    RETURN v_count;
END;
$$;

-- Background status changes (token expired, provider error). No user actor.
CREATE FUNCTION public.set_connection_status(p_connection_id UUID, p_status TEXT)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_status NOT IN ('expired', 'error', 'connected') THEN
        RAISE EXCEPTION 'Unsupported status' USING ERRCODE = '22023';
    END IF;
    UPDATE public.oauth_connections
    SET status = p_status
    WHERE id = p_connection_id
      AND status <> 'revoked'
      AND (p_status <> 'connected' OR EXISTS (
          SELECT 1 FROM private.oauth_credentials oc WHERE oc.connection_id = p_connection_id));
END;
$$;

-- Queue daily syncs for every connected connection with selected accounts,
-- and fail jobs stuck in processing (interrupted function). Returns jobs queued.
CREATE FUNCTION public.enqueue_scheduled_sync_jobs()
RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    UPDATE public.sync_jobs
    SET status = 'failed', completed_at = NOW(), error_message = 'Interrupted before completion'
    WHERE status = 'processing' AND started_at < NOW() - INTERVAL '30 minutes';

    INSERT INTO public.sync_jobs (tenant_id, connection_id, provider, job_type, status)
    SELECT c.tenant_id, c.id, c.provider, 'daily_sync', 'pending'
    FROM public.oauth_connections c
    JOIN public.tenants t ON t.id = c.tenant_id
    WHERE c.status = 'connected'
      AND t.status = 'active'
      AND EXISTS (SELECT 1 FROM public.ad_accounts a WHERE a.connection_id = c.id AND a.sync_enabled)
      AND NOT EXISTS (
          SELECT 1 FROM public.sync_jobs j
          WHERE j.connection_id = c.id
            AND (j.status IN ('pending', 'processing')
                 OR (j.status = 'completed' AND j.completed_at > NOW() - INTERVAL '20 hours')));
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- Claim the next runnable job (or a specific one). Returns NULL when none.
-- SKIP LOCKED lets overlapping invocations work different jobs.
CREATE FUNCTION public.claim_sync_job(p_job_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.sync_jobs%ROWTYPE;
BEGIN
    SELECT j.* INTO v_job
    FROM public.sync_jobs j
    JOIN public.oauth_connections c ON c.id = j.connection_id
    JOIN public.tenants t ON t.id = j.tenant_id
    WHERE j.status = 'pending'
      AND (p_job_id IS NULL OR j.id = p_job_id)
      AND COALESCE(j.scheduled_at, j.created_at) <= NOW()
      AND c.status = 'connected'
      AND t.status = 'active'
    ORDER BY COALESCE(j.scheduled_at, j.created_at)
    LIMIT 1
    FOR UPDATE OF j SKIP LOCKED;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    UPDATE public.sync_jobs
    SET status = 'processing', started_at = NOW(), attempts = attempts + 1
    WHERE id = v_job.id;

    RETURN jsonb_build_object(
        'job_id', v_job.id,
        'tenant_id', v_job.tenant_id,
        'connection_id', v_job.connection_id,
        'provider', v_job.provider,
        'job_type', v_job.job_type,
        'last_success_at', (
            SELECT max(j2.completed_at) FROM public.sync_jobs j2
            WHERE j2.connection_id = v_job.connection_id AND j2.status = 'completed'),
        'accounts', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'id', a.id,
                       'external_account_id', a.external_account_id,
                       'currency', a.currency,
                       'timezone', a.timezone,
                       'metadata', a.metadata) ORDER BY a.external_account_id)
            FROM public.ad_accounts a
            WHERE a.connection_id = v_job.connection_id AND a.sync_enabled), '[]'::JSONB)
    );
END;
$$;

-- Upsert one ad account's campaigns and daily campaign metrics for a job in
-- processing. Idempotent: re-ingesting a day replaces its numbers.
CREATE FUNCTION public.ingest_ad_account_data(
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
        daily_budget, bid_strategy, channel_type, last_synced_at)
    SELECT DISTINCT ON (x.external_id)
           v_account.tenant_id, v_account.id, x.external_id, left(x.name, 500), left(x.objective, 80),
           left(x.status, 40),
           CASE WHEN x.daily_budget >= 0 THEN x.daily_budget END,
           left(x.bid_strategy, 80), left(x.channel_type, 80), NOW()
    FROM jsonb_to_recordset(p_campaigns) AS x(
        external_id TEXT, name TEXT, objective TEXT, status TEXT, daily_budget NUMERIC,
        bid_strategy TEXT, channel_type TEXT)
    WHERE x.external_id IS NOT NULL AND btrim(x.external_id) <> ''
    ON CONFLICT (ad_account_id, external_campaign_id) DO UPDATE
    SET campaign_name = EXCLUDED.campaign_name,
        objective = EXCLUDED.objective,
        campaign_status = EXCLUDED.campaign_status,
        daily_budget = EXCLUDED.daily_budget,
        bid_strategy = EXCLUDED.bid_strategy,
        channel_type = EXCLUDED.channel_type,
        last_synced_at = EXCLUDED.last_synced_at;
    GET DIAGNOSTICS v_campaigns = ROW_COUNT;

    INSERT INTO public.daily_metrics AS m (
        tenant_id, ad_account_id, campaign_id, metric_date, impressions, reach, clicks, spend,
        conversions, conversion_value, currency)
    SELECT DISTINCT ON (cm.id, x.date)
           v_account.tenant_id, v_account.id, cm.id, x.date,
           GREATEST(COALESCE(x.impressions, 0), 0),
           GREATEST(COALESCE(x.reach, 0), 0),
           GREATEST(COALESCE(x.clicks, 0), 0),
           GREATEST(COALESCE(x.spend, 0), 0),
           GREATEST(COALESCE(x.conversions, 0), 0),
           GREATEST(COALESCE(x.conversion_value, 0), 0),
           v_account.currency
    FROM jsonb_to_recordset(p_metrics) AS x(
        external_campaign_id TEXT, date DATE, impressions BIGINT, reach BIGINT, clicks BIGINT,
        spend NUMERIC, conversions NUMERIC, conversion_value NUMERIC)
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
        currency = EXCLUDED.currency;
    GET DIAGNOSTICS v_metrics = ROW_COUNT;

    UPDATE public.ad_accounts SET last_synced_at = NOW() WHERE id = v_account.id;

    RETURN jsonb_build_object('campaigns', v_campaigns, 'metrics', v_metrics);
END;
$$;

-- Finish a job. Error text is stored for staff only (sync_jobs/sync_logs are
-- not readable by tenant users; they see get_tenant_sync_status()).
CREATE FUNCTION public.complete_sync_job(
    p_job_id UUID, p_success BOOLEAN, p_error TEXT DEFAULT NULL, p_stats JSONB DEFAULT '{}'::JSONB)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.sync_jobs%ROWTYPE;
BEGIN
    SELECT * INTO v_job FROM public.sync_jobs j WHERE j.id = p_job_id FOR UPDATE;
    IF NOT FOUND OR v_job.status <> 'processing' THEN
        RAISE EXCEPTION 'Sync job is not running' USING ERRCODE = '22023';
    END IF;

    UPDATE public.sync_jobs
    SET status = CASE WHEN p_success THEN 'completed' ELSE 'failed' END,
        completed_at = NOW(),
        error_message = CASE WHEN p_success THEN NULL ELSE left(COALESCE(p_error, 'Sync failed'), 500) END,
        stats = CASE WHEN jsonb_typeof(p_stats) = 'object' THEN p_stats ELSE '{}'::JSONB END
    WHERE id = p_job_id;

    INSERT INTO public.sync_logs (tenant_id, job_id, level, message, details)
    VALUES (
        v_job.tenant_id, p_job_id,
        CASE WHEN p_success THEN 'info' ELSE 'error' END,
        CASE WHEN p_success THEN 'Sync completed' ELSE left(COALESCE(p_error, 'Sync failed'), 500) END,
        CASE WHEN jsonb_typeof(p_stats) = 'object' THEN p_stats ELSE '{}'::JSONB END);
END;
$$;

-- Housekeeping for the free plan's 500 MB database (called by pg_cron).
CREATE FUNCTION private.prune_operational_data()
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    DELETE FROM private.privileged_actions WHERE expires_at < NOW() - INTERVAL '30 days';
    DELETE FROM public.sync_logs WHERE created_at < NOW() - INTERVAL '90 days';
    UPDATE public.daily_metrics SET source_payload = NULL
    WHERE source_payload IS NOT NULL AND created_at < NOW() - INTERVAL '14 days';
END;
$$;
REVOKE ALL ON FUNCTION private.prune_operational_data() FROM PUBLIC;


-- -----------------------------------------------------
-- 11. PRIVILEGES
-- -----------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.audit_runs, public.audit_findings TO authenticated;
GRANT ALL ON public.audit_runs, public.audit_findings TO service_role;

-- daily_metrics uses column grants (source_payload stays hidden).
GRANT SELECT (conversion_value, updated_at) ON public.daily_metrics TO authenticated;

REVOKE ALL ON FUNCTION
    public.get_campaign_performance(UUID, DATE, DATE, UUID),
    public.get_daily_performance(UUID, DATE, DATE, UUID),
    public.get_tenant_members(UUID),
    public.set_ad_account_sync(UUID, UUID[]),
    public.save_audit_run(UUID, JSONB, JSONB),
    public.set_audit_run_status(UUID, TEXT, TEXT),
    public.get_platform_overview(),
    public.upsert_discovered_ad_accounts(UUID, UUID, JSONB, TEXT, TEXT, TEXT[]),
    public.set_connection_status(UUID, TEXT),
    public.enqueue_scheduled_sync_jobs(),
    public.claim_sync_job(UUID),
    public.ingest_ad_account_data(UUID, UUID, JSONB, JSONB),
    public.complete_sync_job(UUID, BOOLEAN, TEXT, JSONB)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
    public.get_campaign_performance(UUID, DATE, DATE, UUID),
    public.get_daily_performance(UUID, DATE, DATE, UUID),
    public.get_tenant_members(UUID),
    public.set_ad_account_sync(UUID, UUID[]),
    public.save_audit_run(UUID, JSONB, JSONB),
    public.set_audit_run_status(UUID, TEXT, TEXT),
    public.get_platform_overview()
TO authenticated;

GRANT EXECUTE ON FUNCTION
    public.upsert_discovered_ad_accounts(UUID, UUID, JSONB, TEXT, TEXT, TEXT[]),
    public.set_connection_status(UUID, TEXT),
    public.enqueue_scheduled_sync_jobs(),
    public.claim_sync_job(UUID),
    public.ingest_ad_account_data(UUID, UUID, JSONB, JSONB),
    public.complete_sync_job(UUID, BOOLEAN, TEXT, JSONB)
TO service_role;


-- -----------------------------------------------------
-- 12. REALTIME
-- -----------------------------------------------------
-- Realtime applies each subscriber's RLS, so tenants only receive their own
-- rows (and never sync_jobs, which are staff-only).
DO $$
DECLARE
    v_table TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        FOREACH v_table IN ARRAY ARRAY['sync_jobs', 'ad_accounts', 'audit_runs', 'reports'] LOOP
            IF NOT EXISTS (
                SELECT 1 FROM pg_publication_tables
                WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = v_table) THEN
                EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
            END IF;
        END LOOP;
    END IF;
END;
$$;


-- -----------------------------------------------------
-- 13. DOCUMENTATION COMMENTS
-- -----------------------------------------------------
COMMENT ON TABLE public.audit_runs IS
    'Reviewed advertising audits. Clients read published runs only; published runs are immutable.';
COMMENT ON TABLE public.audit_findings IS
    'Findings of an audit run. Clients read non-dismissed findings of published runs.';
COMMENT ON COLUMN public.reports.visibility IS
    'internal = staff only; client = shared with tenant members (requires ready file and published audit).';
COMMENT ON FUNCTION public.get_campaign_performance(UUID, DATE, DATE, UUID) IS
    'Per-campaign totals for a period. SECURITY INVOKER: RLS applies.';
COMMENT ON FUNCTION public.get_daily_performance(UUID, DATE, DATE, UUID) IS
    'Per-account daily totals from campaign-level rows. SECURITY INVOKER: RLS applies.';
COMMENT ON FUNCTION public.get_tenant_members(UUID) IS
    'Tenant member directory for tenant owners/admins and aal2 platform admins.';
COMMENT ON FUNCTION public.set_ad_account_sync(UUID, UUID[]) IS
    'Manager+ (or aal2 platform admin) selects which accounts of a connection are synced.';
COMMENT ON FUNCTION public.save_audit_run(UUID, JSONB, JSONB) IS
    'aal2 platform admin stores an audit engine result as a draft.';
COMMENT ON FUNCTION public.set_audit_run_status(UUID, TEXT, TEXT) IS
    'aal2 platform admin moves an audit through review; publishing records reviewer and scores.';
COMMENT ON FUNCTION public.get_platform_overview() IS
    'aal2 platform admin dashboard counters.';
COMMENT ON FUNCTION public.upsert_discovered_ad_accounts(UUID, UUID, JSONB, TEXT, TEXT, TEXT[]) IS
    'service_role only. Records discovered ad accounts for a connection bound to an oauth.connect action.';
COMMENT ON FUNCTION public.set_connection_status(UUID, TEXT) IS
    'service_role only. Marks a connection expired/error (or connected again when credentials exist).';
COMMENT ON FUNCTION public.enqueue_scheduled_sync_jobs() IS
    'service_role only. Queues daily syncs and fails jobs stuck in processing.';
COMMENT ON FUNCTION public.claim_sync_job(UUID) IS
    'service_role only. Claims a pending sync job and returns its selected accounts.';
COMMENT ON FUNCTION public.ingest_ad_account_data(UUID, UUID, JSONB, JSONB) IS
    'service_role only. Upserts campaigns and daily campaign metrics for a running job.';
COMMENT ON FUNCTION public.complete_sync_job(UUID, BOOLEAN, TEXT, JSONB) IS
    'service_role only. Finishes a running job and writes a sync log entry.';

-- Audit platform completed.
