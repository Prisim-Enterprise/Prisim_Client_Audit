
-- =====================================================
-- PRISIM CLIENT AUDIT PORTAL
-- INITIAL DATABASE SCHEMA
-- PostgreSQL / Supabase
-- =====================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. TENANTS
CREATE TABLE public.tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    email TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive', 'suspended')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. USER PROFILES
CREATE TABLE public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name TEXT,
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. TENANT MEMBERSHIPS
CREATE TABLE public.tenant_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'client'
        CHECK (role IN ('owner', 'admin', 'manager', 'viewer', 'client')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive', 'invited')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id)
);

-- 4. OAUTH CONNECTIONS
-- Tokens must be encrypted by trusted backend code.
CREATE TABLE public.oauth_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    provider TEXT NOT NULL
        CHECK (provider IN ('meta', 'google')),
    provider_account_id TEXT,
    account_name TEXT,
    encrypted_access_token TEXT,
    encrypted_refresh_token TEXT,
    token_expires_at TIMESTAMPTZ,
    scopes TEXT[],
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'connected', 'expired', 'revoked', 'error')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. AD ACCOUNTS
CREATE TABLE public.ad_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    connection_id UUID REFERENCES public.oauth_connections(id) ON DELETE SET NULL,
    provider TEXT NOT NULL CHECK (provider IN ('meta', 'google')),
    external_account_id TEXT NOT NULL,
    account_name TEXT,
    currency TEXT,
    timezone TEXT,
    status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, provider, external_account_id)
);

-- 6. CAMPAIGNS
CREATE TABLE public.campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    ad_account_id UUID NOT NULL REFERENCES public.ad_accounts(id) ON DELETE CASCADE,
    external_campaign_id TEXT NOT NULL,
    campaign_name TEXT,
    objective TEXT,
    campaign_status TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (ad_account_id, external_campaign_id)
);

-- 7. DAILY METRICS
CREATE TABLE public.daily_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    ad_account_id UUID NOT NULL REFERENCES public.ad_accounts(id) ON DELETE CASCADE,
    campaign_id UUID REFERENCES public.campaigns(id) ON DELETE CASCADE,
    metric_date DATE NOT NULL,
    impressions BIGINT NOT NULL DEFAULT 0,
    reach BIGINT NOT NULL DEFAULT 0,
    clicks BIGINT NOT NULL DEFAULT 0,
    spend NUMERIC(18, 4) NOT NULL DEFAULT 0,
    conversions NUMERIC(18, 4) NOT NULL DEFAULT 0,
    currency TEXT,
    source_payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (ad_account_id, campaign_id, metric_date)
);

-- 8. AUDIT SCORES
CREATE TABLE public.audit_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    audit_date DATE NOT NULL DEFAULT CURRENT_DATE,
    platform TEXT,
    score NUMERIC(5, 2),
    findings JSONB NOT NULL DEFAULT '[]'::JSONB,
    recommendations JSONB NOT NULL DEFAULT '[]'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. SYNC JOBS
CREATE TABLE public.sync_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    connection_id UUID REFERENCES public.oauth_connections(id) ON DELETE SET NULL,
    provider TEXT NOT NULL CHECK (provider IN ('meta', 'google')),
    job_type TEXT NOT NULL DEFAULT 'daily_sync',
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    scheduled_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 10. SYNC LOGS
CREATE TABLE public.sync_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    job_id UUID REFERENCES public.sync_jobs(id) ON DELETE SET NULL,
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT,
    details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. REPORTS
CREATE TABLE public.reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    report_name TEXT NOT NULL,
    report_type TEXT,
    storage_path TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    generated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 12. AUDIT LOGS
CREATE TABLE public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id UUID,
    details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 13. PERFORMANCE INDEXES
CREATE INDEX idx_memberships_user ON public.tenant_memberships(user_id);
CREATE INDEX idx_memberships_tenant ON public.tenant_memberships(tenant_id);
CREATE INDEX idx_oauth_tenant ON public.oauth_connections(tenant_id);
CREATE INDEX idx_ad_accounts_tenant ON public.ad_accounts(tenant_id);
CREATE INDEX idx_campaigns_tenant ON public.campaigns(tenant_id);
CREATE INDEX idx_metrics_tenant_date ON public.daily_metrics(tenant_id, metric_date);
CREATE INDEX idx_metrics_account_date ON public.daily_metrics(ad_account_id, metric_date);
CREATE INDEX idx_audit_scores_tenant_date ON public.audit_scores(tenant_id, audit_date);
CREATE INDEX idx_sync_jobs_status ON public.sync_jobs(status, scheduled_at);
CREATE INDEX idx_sync_logs_tenant ON public.sync_logs(tenant_id, created_at DESC);
CREATE INDEX idx_reports_tenant ON public.reports(tenant_id, created_at DESC);

-- 14. TENANT ACCESS HELPER
-- SECURITY DEFINER avoids recursive membership RLS evaluation.
CREATE OR REPLACE FUNCTION public.is_tenant_member(check_tenant UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.tenant_memberships tm
        WHERE tm.tenant_id = check_tenant
          AND tm.user_id = (SELECT auth.uid())
          AND tm.status = 'active'
    );
$$;

REVOKE ALL ON FUNCTION public.is_tenant_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_tenant_member(UUID) TO authenticated;

-- 15. ENABLE ROW LEVEL SECURITY
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- 16. PROFILE POLICIES
CREATE POLICY "Users can view own profile"
ON public.profiles
FOR SELECT TO authenticated
USING (id = (SELECT auth.uid()));

-- 17. TENANT POLICIES
CREATE POLICY "Members can view their tenants"
ON public.tenants
FOR SELECT TO authenticated
USING (public.is_tenant_member(id));

-- 18. MEMBERSHIP POLICIES
CREATE POLICY "Members can view tenant memberships"
ON public.tenant_memberships
FOR SELECT TO authenticated
USING (public.is_tenant_member(tenant_id));

-- 19. CLIENT READ POLICIES
CREATE POLICY "Members can view ad accounts"
ON public.ad_accounts
FOR SELECT TO authenticated
USING (public.is_tenant_member(tenant_id));

CREATE POLICY "Members can view campaigns"
ON public.campaigns
FOR SELECT TO authenticated
USING (public.is_tenant_member(tenant_id));

CREATE POLICY "Members can view daily metrics"
ON public.daily_metrics
FOR SELECT TO authenticated
USING (public.is_tenant_member(tenant_id));

CREATE POLICY "Members can view audit scores"
ON public.audit_scores
FOR SELECT TO authenticated
USING (public.is_tenant_member(tenant_id));

CREATE POLICY "Members can view sync jobs"
ON public.sync_jobs
FOR SELECT TO authenticated
USING (public.is_tenant_member(tenant_id));

CREATE POLICY "Members can view sync logs"
ON public.sync_logs
FOR SELECT TO authenticated
USING (public.is_tenant_member(tenant_id));

CREATE POLICY "Members can view reports"
ON public.reports
FOR SELECT TO authenticated
USING (public.is_tenant_member(tenant_id));

-- No direct client policies for OAuth connections or audit_logs.
-- These tables are accessed only through trusted backend operations.

-- 20. GRANT BASIC TABLE ACCESS
GRANT SELECT ON
    public.tenants,
    public.profiles,
    public.tenant_memberships,
    public.ad_accounts,
    public.campaigns,
    public.daily_metrics,
    public.audit_scores,
    public.sync_jobs,
    public.sync_logs,
    public.reports
TO authenticated;

-- Schema foundation completed.
