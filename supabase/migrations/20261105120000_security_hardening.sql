-- =====================================================
-- PRISIM CLIENT AUDIT PORTAL
-- MIGRATION 20261105120000 - SECURITY HARDENING
-- PostgreSQL 17 / Supabase
-- =====================================================
--
-- STATUS: PROPOSED - pending approval. Do not apply to the hosted project
-- until it has been reviewed and validated locally with:
--     npx supabase db reset && npx supabase test db
--
-- Builds on 202611050001_initial_schema.sql (already applied; never edit it).
-- Hosted prerequisites and Edge Function rules: docs/deployment-checklist.md
-- and docs/edge-function-contract.md.
--
-- What this migration does
--   1.  `private` schema for internal helpers and OAuth credentials
--   2.  Platform administrators (PRISIM staff, cross-tenant access); their
--       privileges require an MFA-verified (aal2) session
--   3.  Tenant role hierarchy: owner > admin > manager > viewer = client(read)
--   4.  Suspended/inactive tenants lose client access
--   5.  Composite foreign keys so child rows cannot point at another tenant
--       (and campaign metrics cannot point at another ad account)
--   6.  daily_metrics uniqueness that also covers account-level rows
--   7.  OAuth tokens moved to Supabase Vault (legacy columns locked to NULL)
--   8.  Profile auto-creation, e-mail sync and updated_at triggers
--   9.  Missing indexes and CHECK constraints
--   10. Tenant invitation workflow (DB-generated hashed tokens, strict status
--       transitions) and member-management RPCs that authorize in SQL
--   11. Private `reports` storage bucket (forced private) with tenant-folder
--       policies
--   12. Explicit grants (no implicit anon/authenticated access);
--       daily_metrics.source_payload is not readable through the API
--   13. sync_jobs / sync_logs restricted to platform admins; clients get a
--       sanitized status RPC
--   14. Append-only audit trail (trigger-written only, actor from the JWT,
--       or from a user-created privileged action for service_role work)
--   15. Every tenant keeps an active owner, for every role (trigger)
--
-- Destructive operations (no table, column or row is dropped):
--   * Drops the foreign keys audit_logs.tenant_id / audit_logs.user_id from
--     202611050001. Their ON DELETE SET NULL rewrote audit rows; the ids are
--     now kept as plain values so audit rows are immutable.
--   * Replaces the RLS policies created in 202611050001 (except the profile
--     self-read policy) with role-aware equivalents.
--   * Replaces UNIQUE (ad_account_id, campaign_id, metric_date) on
--     daily_metrics with a NULLS NOT DISTINCT version of the same columns.
--   * Redefines public.is_tenant_member() (same signature) so it also
--     requires an active tenant.
--   * Revokes all implicit table privileges from anon/authenticated and
--     re-grants only what is listed in section 17.
--
-- The migration aborts (and the CLI rolls it back) if existing data violates
-- a new constraint; nothing is silently modified.
-- =====================================================


-- -----------------------------------------------------
-- 1. EXTENSIONS AND PRIVATE SCHEMA
-- -----------------------------------------------------
-- Vault is pre-installed on hosted Supabase; this is a no-op there.
CREATE EXTENSION IF NOT EXISTS supabase_vault;

CREATE SCHEMA IF NOT EXISTS private;
COMMENT ON SCHEMA private IS
    'Internal helpers and credentials. Not exposed through the Data API.';

REVOKE ALL ON SCHEMA private FROM PUBLIC;
-- USAGE lets RLS policies (evaluated as the caller) execute helper functions.
-- No table in this schema is granted to anon/authenticated.
GRANT USAGE ON SCHEMA private TO authenticated, service_role;


-- -----------------------------------------------------
-- 2. PLATFORM ADMINISTRATORS
-- -----------------------------------------------------
-- Rows are managed only through SQL by a project owner (see docs/security.md).
CREATE TABLE public.platform_admins (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.platform_admins IS
    'PRISIM staff with cross-tenant administrator access. Managed via SQL only.';


-- -----------------------------------------------------
-- 3. AUTHORIZATION HELPERS
-- -----------------------------------------------------
-- Role rank. Unknown roles rank 0 and never satisfy a check.
CREATE FUNCTION private.tenant_role_rank(p_role TEXT)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT CASE p_role
        WHEN 'owner'   THEN 50
        WHEN 'admin'   THEN 40
        WHEN 'manager' THEN 30
        WHEN 'viewer'  THEN 10
        WHEN 'client'  THEN 10
        ELSE 0
    END;
$$;

-- Listed in platform_admins, regardless of how the session authenticated.
-- Used only to tell the UI that an MFA step-up is needed; never for access.
CREATE FUNCTION private.is_listed_platform_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.platform_admins pa
        WHERE pa.user_id = (SELECT auth.uid())
    );
$$;

-- Platform-admin privileges require an MFA-verified session (JWT aal = aal2).
-- An aal1 session of a listed admin gets no admin privileges at all.
-- service_role has no `sub`, so this is always FALSE for it; service_role
-- relies on BYPASSRLS and explicit function grants instead.
CREATE FUNCTION private.is_platform_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT COALESCE((SELECT auth.jwt() ->> 'aal'), '') = 'aal2'
       AND private.is_listed_platform_admin();
$$;

-- Tenants where the caller has an active membership of at least p_min_role
-- AND the tenant itself is active. Used as `tenant_id IN (SELECT ...)` so the
-- planner evaluates it once per statement instead of once per row.
CREATE FUNCTION private.my_tenant_ids(p_min_role TEXT DEFAULT 'client')
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT tm.tenant_id
    FROM public.tenant_memberships tm
    JOIN public.tenants t ON t.id = tm.tenant_id
    WHERE tm.user_id = (SELECT auth.uid())
      AND tm.status = 'active'
      AND t.status = 'active'
      AND private.tenant_role_rank(p_min_role) > 0
      AND private.tenant_role_rank(tm.role) >= private.tenant_role_rank(p_min_role);
$$;

CREATE FUNCTION private.has_tenant_role(p_tenant UUID, p_min_role TEXT DEFAULT 'client')
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT p_tenant IS NOT NULL
       AND p_tenant IN (SELECT private.my_tenant_ids(p_min_role));
$$;

-- Owners/admins/managers may see the profiles of people in their tenant.
CREATE FUNCTION private.can_view_profile(p_profile UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.tenant_memberships target
        WHERE target.user_id = p_profile
          AND target.tenant_id IN (SELECT private.my_tenant_ids('manager'))
    );
$$;

CREATE FUNCTION private.try_uuid(p_value TEXT)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
    RETURN p_value::UUID;
EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
END;
$$;

-- Storage objects in the `reports` bucket live under "<tenant_id>/...".
CREATE FUNCTION private.can_read_tenant_object(p_object_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT private.is_platform_admin()
        OR private.has_tenant_role(private.try_uuid(split_part(p_object_name, '/', 1)), 'client');
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    private.tenant_role_rank(TEXT),
    private.is_listed_platform_admin(),
    private.is_platform_admin(),
    private.my_tenant_ids(TEXT),
    private.has_tenant_role(UUID, TEXT),
    private.can_view_profile(UUID),
    private.try_uuid(TEXT),
    private.can_read_tenant_object(TEXT)
TO authenticated, service_role;


-- -----------------------------------------------------
-- 4. EXISTING HELPER: NOW STATUS-AWARE
-- -----------------------------------------------------
-- Same signature and grants as 202611050001; now also requires an active
-- tenant. Kept for backward compatibility; new policies use private.*.
CREATE OR REPLACE FUNCTION public.is_tenant_member(check_tenant UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT private.has_tenant_role(check_tenant, 'client');
$$;


-- -----------------------------------------------------
-- 5. NEW COLUMNS (additive)
-- -----------------------------------------------------
ALTER TABLE public.profiles
    ADD COLUMN email TEXT;
COMMENT ON COLUMN public.profiles.email IS
    'Copy of auth.users.email maintained by trigger. Read-only for users.';

ALTER TABLE public.tenant_memberships
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE public.ad_accounts
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Who made the change, as established by the verified JWT (or the database
-- login role for direct SQL sessions). Never taken from request bodies.
ALTER TABLE public.audit_logs
    ADD COLUMN actor_role TEXT;
COMMENT ON COLUMN public.audit_logs.actor_role IS
    'JWT role of the actor (authenticated, service_role) or the database session user for direct SQL.';
COMMENT ON COLUMN public.audit_logs.user_id IS
    'auth.uid() of the actor. NULL for service_role and direct SQL. Not a foreign key: survives user deletion.';


-- -----------------------------------------------------
-- 6. CHECK CONSTRAINTS
-- -----------------------------------------------------
ALTER TABLE public.tenants
    ADD CONSTRAINT tenants_business_name_not_blank CHECK (btrim(business_name) <> ''),
    ADD CONSTRAINT tenants_slug_format CHECK (
        slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 2 AND 63
    );

ALTER TABLE public.ad_accounts
    ADD CONSTRAINT ad_accounts_status_check CHECK (
        status IS NULL OR status IN ('active', 'paused', 'disabled', 'closed', 'unknown')
    ),
    ADD CONSTRAINT ad_accounts_currency_format CHECK (
        currency IS NULL OR currency ~ '^[A-Z]{3}$'
    );

ALTER TABLE public.daily_metrics
    ADD CONSTRAINT daily_metrics_non_negative CHECK (
        impressions >= 0 AND reach >= 0 AND clicks >= 0 AND spend >= 0 AND conversions >= 0
    ),
    ADD CONSTRAINT daily_metrics_currency_format CHECK (
        currency IS NULL OR currency ~ '^[A-Z]{3}$'
    );

ALTER TABLE public.audit_scores
    ADD CONSTRAINT audit_scores_score_range CHECK (score IS NULL OR score BETWEEN 0 AND 100),
    ADD CONSTRAINT audit_scores_platform_check CHECK (
        platform IS NULL OR platform IN ('meta', 'google', 'overall')
    ),
    ADD CONSTRAINT audit_scores_findings_array CHECK (jsonb_typeof(findings) = 'array'),
    ADD CONSTRAINT audit_scores_recommendations_array CHECK (jsonb_typeof(recommendations) = 'array');

ALTER TABLE public.sync_jobs
    ADD CONSTRAINT sync_jobs_attempts_non_negative CHECK (attempts >= 0),
    ADD CONSTRAINT sync_jobs_job_type_check CHECK (
        job_type IN ('daily_sync', 'backfill', 'manual_sync')
    );

ALTER TABLE public.sync_logs
    ADD CONSTRAINT sync_logs_level_check CHECK (level IN ('debug', 'info', 'warn', 'error'));

ALTER TABLE public.reports
    ADD CONSTRAINT reports_status_check CHECK (
        status IN ('pending', 'generating', 'ready', 'failed')
    ),
    -- Report files must live inside the owning tenant's storage folder.
    ADD CONSTRAINT reports_storage_path_in_tenant_folder CHECK (
        storage_path IS NULL OR storage_path LIKE tenant_id::TEXT || '/%'
    );


-- -----------------------------------------------------
-- 7. CROSS-TENANT FOREIGN-KEY INTEGRITY
-- -----------------------------------------------------
-- Composite keys make it impossible for a child row to reference a parent
-- that belongs to a different tenant. The original single-column FKs stay.
ALTER TABLE public.oauth_connections ADD CONSTRAINT oauth_connections_id_tenant_key UNIQUE (id, tenant_id);
ALTER TABLE public.ad_accounts       ADD CONSTRAINT ad_accounts_id_tenant_key       UNIQUE (id, tenant_id);
ALTER TABLE public.campaigns         ADD CONSTRAINT campaigns_id_tenant_key         UNIQUE (id, tenant_id);
ALTER TABLE public.sync_jobs         ADD CONSTRAINT sync_jobs_id_tenant_key         UNIQUE (id, tenant_id);

ALTER TABLE public.ad_accounts
    ADD CONSTRAINT ad_accounts_connection_same_tenant_fkey
    FOREIGN KEY (connection_id, tenant_id)
    REFERENCES public.oauth_connections (id, tenant_id)
    ON DELETE SET NULL (connection_id);

ALTER TABLE public.campaigns
    ADD CONSTRAINT campaigns_ad_account_same_tenant_fkey
    FOREIGN KEY (ad_account_id, tenant_id)
    REFERENCES public.ad_accounts (id, tenant_id)
    ON DELETE CASCADE;

ALTER TABLE public.daily_metrics
    ADD CONSTRAINT daily_metrics_ad_account_same_tenant_fkey
    FOREIGN KEY (ad_account_id, tenant_id)
    REFERENCES public.ad_accounts (id, tenant_id)
    ON DELETE CASCADE;

ALTER TABLE public.daily_metrics
    ADD CONSTRAINT daily_metrics_campaign_same_tenant_fkey
    FOREIGN KEY (campaign_id, tenant_id)
    REFERENCES public.campaigns (id, tenant_id)
    ON DELETE CASCADE;

ALTER TABLE public.sync_jobs
    ADD CONSTRAINT sync_jobs_connection_same_tenant_fkey
    FOREIGN KEY (connection_id, tenant_id)
    REFERENCES public.oauth_connections (id, tenant_id)
    ON DELETE SET NULL (connection_id);

ALTER TABLE public.sync_logs
    ADD CONSTRAINT sync_logs_job_same_tenant_fkey
    FOREIGN KEY (job_id, tenant_id)
    REFERENCES public.sync_jobs (id, tenant_id)
    ON DELETE SET NULL (job_id);

-- A campaign-level metric must belong to the same ad account as its campaign.
ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_id_ad_account_key UNIQUE (id, ad_account_id);
ALTER TABLE public.daily_metrics
    ADD CONSTRAINT daily_metrics_campaign_same_account_fkey
    FOREIGN KEY (campaign_id, ad_account_id)
    REFERENCES public.campaigns (id, ad_account_id)
    ON DELETE CASCADE;

-- Audit rows must never change. The 202611050001 foreign keys on audit_logs
-- used ON DELETE SET NULL, which rewrote audit rows (and erased the actor)
-- whenever a tenant or user was deleted. Ids are kept as plain values.
ALTER TABLE public.audit_logs DROP CONSTRAINT audit_logs_tenant_id_fkey;
ALTER TABLE public.audit_logs DROP CONSTRAINT audit_logs_user_id_fkey;


-- -----------------------------------------------------
-- 8. DAILY_METRICS UNIQUENESS
-- -----------------------------------------------------
-- The original constraint treated NULL campaign_id values as distinct, so
-- account-level rows could be duplicated. Fails loudly if duplicates exist.
ALTER TABLE public.daily_metrics
    DROP CONSTRAINT IF EXISTS daily_metrics_ad_account_id_campaign_id_metric_date_key;

ALTER TABLE public.daily_metrics
    ADD CONSTRAINT daily_metrics_account_campaign_date_key
    UNIQUE NULLS NOT DISTINCT (ad_account_id, campaign_id, metric_date);


-- -----------------------------------------------------
-- 9. MISSING INDEXES
-- -----------------------------------------------------
CREATE INDEX idx_metrics_campaign        ON public.daily_metrics (campaign_id);
CREATE INDEX idx_ad_accounts_connection  ON public.ad_accounts (connection_id);
CREATE INDEX idx_sync_jobs_tenant        ON public.sync_jobs (tenant_id, created_at DESC);
CREATE INDEX idx_sync_jobs_connection    ON public.sync_jobs (connection_id);
CREATE INDEX idx_sync_logs_job           ON public.sync_logs (job_id);
CREATE INDEX idx_audit_logs_tenant       ON public.audit_logs (tenant_id, created_at DESC);
CREATE INDEX idx_audit_logs_user         ON public.audit_logs (user_id);
CREATE INDEX idx_platform_admins_granted ON public.platform_admins (granted_by);


-- -----------------------------------------------------
-- 10. INVITATIONS
-- -----------------------------------------------------
-- Only the SHA-256 hash of the invitation token is stored. The raw token is
-- generated by the invite Edge Function and delivered only by e-mail.
CREATE TABLE public.tenant_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    email TEXT NOT NULL CHECK (
        email = lower(btrim(email)) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    ),
    role TEXT NOT NULL DEFAULT 'client'
        CHECK (role IN ('owner', 'admin', 'manager', 'viewer', 'client')),
    token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
    invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    accepted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.tenant_invitations ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX uq_invitations_pending_email
    ON public.tenant_invitations (tenant_id, email)
    WHERE status = 'pending';
CREATE INDEX idx_invitations_tenant      ON public.tenant_invitations (tenant_id, created_at DESC);
CREATE INDEX idx_invitations_invited_by  ON public.tenant_invitations (invited_by);
CREATE INDEX idx_invitations_accepted_by ON public.tenant_invitations (accepted_by);
CREATE INDEX idx_invitations_pending_expiry
    ON public.tenant_invitations (expires_at)
    WHERE status = 'pending';

-- Invitation lifecycle: pending -> accepted | revoked | expired, and nothing
-- else. Terminal states are final and the invitation's details never change.
-- (invited_by / accepted_by may only become NULL, via ON DELETE SET NULL.)
CREATE FUNCTION private.enforce_invitation_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF NEW.id <> OLD.id
       OR NEW.tenant_id <> OLD.tenant_id
       OR NEW.email <> OLD.email
       OR NEW.role <> OLD.role
       OR NEW.token_hash <> OLD.token_hash
       OR NEW.expires_at <> OLD.expires_at
       OR NEW.created_at <> OLD.created_at
       OR (NEW.invited_by IS DISTINCT FROM OLD.invited_by AND NEW.invited_by IS NOT NULL)
    THEN
        RAISE EXCEPTION 'Invitation details cannot be changed' USING ERRCODE = '23514';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF OLD.status <> 'pending' THEN
            RAISE EXCEPTION 'Invitation is already %', OLD.status USING ERRCODE = '23514';
        END IF;
        IF NEW.status = 'accepted' AND (NEW.accepted_by IS NULL OR NEW.accepted_at IS NULL) THEN
            RAISE EXCEPTION 'Accepted invitations need accepted_by and accepted_at' USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.status <> 'accepted' AND (NEW.accepted_by IS NOT NULL OR NEW.accepted_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Only accepted invitations carry acceptance details' USING ERRCODE = '23514';
    END IF;
    IF (NEW.accepted_by IS DISTINCT FROM OLD.accepted_by AND NOT (NEW.accepted_by IS NULL OR OLD.status = 'pending'))
       OR (NEW.accepted_at IS DISTINCT FROM OLD.accepted_at AND OLD.status <> 'pending')
    THEN
        RAISE EXCEPTION 'Acceptance details cannot be changed' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_invitation_transition
BEFORE UPDATE ON public.tenant_invitations
FOR EACH ROW EXECUTE FUNCTION private.enforce_invitation_transition();


-- -----------------------------------------------------
-- 11. OAUTH CREDENTIALS (SUPABASE VAULT)
-- -----------------------------------------------------
-- Legacy plaintext-capable columns stay (no drops) but must remain NULL.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.oauth_connections
        WHERE encrypted_access_token IS NOT NULL OR encrypted_refresh_token IS NOT NULL
    ) THEN
        RAISE EXCEPTION
            'public.oauth_connections holds tokens in legacy columns. Move them into Vault before applying this migration.';
    END IF;
END;
$$;

ALTER TABLE public.oauth_connections
    ADD CONSTRAINT oauth_connections_no_legacy_tokens
    CHECK (encrypted_access_token IS NULL AND encrypted_refresh_token IS NULL);

COMMENT ON COLUMN public.oauth_connections.encrypted_access_token IS
    'DEPRECATED - always NULL. Tokens live in Vault via private.oauth_credentials.';
COMMENT ON COLUMN public.oauth_connections.encrypted_refresh_token IS
    'DEPRECATED - always NULL. Tokens live in Vault via private.oauth_credentials.';

-- Maps a connection to its Vault secret ids. Never granted to API roles.
CREATE TABLE private.oauth_credentials (
    connection_id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    access_token_secret_id UUID,
    refresh_token_secret_id UUID,
    token_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (connection_id, tenant_id)
        REFERENCES public.oauth_connections (id, tenant_id)
        ON DELETE CASCADE
);
ALTER TABLE private.oauth_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.oauth_credentials FROM PUBLIC, anon, authenticated, service_role;
CREATE INDEX idx_oauth_credentials_tenant ON private.oauth_credentials (tenant_id);

-- Remove Vault secrets that are no longer referenced: when a credential row
-- disappears (including cascades from connection or tenant deletion) or when
-- an UPDATE points it at different secrets.
CREATE FUNCTION private.purge_oauth_secrets()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM vault.secrets
        WHERE id IN (OLD.access_token_secret_id, OLD.refresh_token_secret_id);
        RETURN OLD;
    END IF;

    DELETE FROM vault.secrets
    WHERE id IN (OLD.access_token_secret_id, OLD.refresh_token_secret_id)
      AND id IS DISTINCT FROM NEW.access_token_secret_id
      AND id IS DISTINCT FROM NEW.refresh_token_secret_id;
    RETURN NEW;
END;
$$;

CREATE TRIGGER purge_oauth_secrets
AFTER DELETE OR UPDATE OF access_token_secret_id, refresh_token_secret_id ON private.oauth_credentials
FOR EACH ROW EXECUTE FUNCTION private.purge_oauth_secrets();


-- -----------------------------------------------------
-- 11b. PRIVILEGED ACTIONS (attribution for service_role work)
-- -----------------------------------------------------
-- Some work must run with service_role (OAuth token exchange, starting a
-- sync), where auth.uid() is NULL. To attribute it to a person without ever
-- trusting an actor id sent by a caller:
--   1. The user, with their OWN JWT, calls begin_privileged_action(). The
--      database checks their role and records auth.uid() as the actor.
--   2. The Edge Function passes the returned action id to a service_role RPC.
--      That RPC re-validates the action (same action type, same tenant and
--      target, not expired, initiator still authorized) and marks it for the
--      transaction.
--   3. The audit trigger records the action's actor as user_id for every
--      change in that transaction that belongs to the action's tenant.
-- A caller can only "borrow" an identity by holding an action id that the
-- real user created for that exact tenant and purpose in the last 15 minutes.
CREATE TABLE private.privileged_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL,
    actor_authority TEXT NOT NULL,
    action TEXT NOT NULL
        CHECK (action IN ('oauth.connect', 'oauth.disconnect', 'sync.start', 'report.generate')),
    target_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),
    last_used_at TIMESTAMPTZ
);
ALTER TABLE private.privileged_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.privileged_actions FROM PUBLIC, anon, authenticated, service_role;
CREATE INDEX idx_privileged_actions_actor  ON private.privileged_actions (actor_id, created_at DESC);
CREATE INDEX idx_privileged_actions_tenant ON private.privileged_actions (tenant_id);
COMMENT ON TABLE private.privileged_actions IS
    'User-initiated authorizations for service_role work; source of audit attribution.';

-- Validates an action for use by a service_role RPC and binds it to the
-- current transaction. Raises 42501 for anything that does not match.
CREATE FUNCTION private.use_privileged_action(
    p_action_id UUID, p_action TEXT, p_tenant_id UUID, p_target_id UUID)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_act private.privileged_actions%ROWTYPE;
BEGIN
    SELECT * INTO v_act FROM private.privileged_actions a WHERE a.id = p_action_id FOR UPDATE;

    IF NOT FOUND
       OR v_act.action <> p_action
       OR v_act.tenant_id IS DISTINCT FROM p_tenant_id
       OR v_act.expires_at <= NOW()
       OR (v_act.target_id IS NOT NULL AND v_act.target_id IS DISTINCT FROM p_target_id)
    THEN
        RAISE EXCEPTION 'Privileged action is invalid or has expired' USING ERRCODE = '42501';
    END IF;

    -- The initiator must still hold the authority they had when they asked.
    IF v_act.actor_authority = 'platform_admin' THEN
        IF NOT EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = v_act.actor_id) THEN
            RAISE EXCEPTION 'Privileged action is invalid or has expired' USING ERRCODE = '42501';
        END IF;
    ELSIF NOT EXISTS (
        SELECT 1
        FROM public.tenant_memberships tm
        JOIN public.tenants t ON t.id = tm.tenant_id
        WHERE tm.tenant_id = v_act.tenant_id
          AND tm.user_id = v_act.actor_id
          AND tm.status = 'active'
          AND t.status = 'active'
          AND private.tenant_role_rank(tm.role) >= private.tenant_role_rank('manager')
    ) THEN
        RAISE EXCEPTION 'Privileged action is invalid or has expired' USING ERRCODE = '42501';
    END IF;

    UPDATE private.privileged_actions SET last_used_at = NOW() WHERE id = v_act.id;
    PERFORM set_config('prisim.privileged_action_id', v_act.id::TEXT, TRUE);
    RETURN v_act.actor_id;
END;
$$;
REVOKE ALL ON FUNCTION private.use_privileged_action(UUID, TEXT, UUID, UUID) FROM PUBLIC;


-- -----------------------------------------------------
-- 12. TRIGGERS: updated_at, profiles, audit trail
-- -----------------------------------------------------
CREATE FUNCTION private.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.tenants            FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.profiles           FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.tenant_memberships FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.oauth_connections  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.ad_accounts        FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.campaigns          FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.tenant_invitations FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON private.oauth_credentials FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

-- Profile row for every auth user. Only `full_name` is read from the
-- user-controlled metadata; nothing authorization-related is.
CREATE FUNCTION private.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.profiles (id, email, full_name)
    VALUES (NEW.id, NEW.email, NULLIF(btrim(NEW.raw_user_meta_data ->> 'full_name'), ''))
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
    RETURN NEW;
END;
$$;

CREATE FUNCTION private.handle_user_email_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    UPDATE public.profiles SET email = NEW.email WHERE id = NEW.id;
    RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION private.handle_new_user();

CREATE TRIGGER on_auth_user_email_changed
AFTER UPDATE OF email ON auth.users
FOR EACH ROW
WHEN (OLD.email IS DISTINCT FROM NEW.email)
EXECUTE FUNCTION private.handle_user_email_change();

-- Backfill profiles for users created before this migration.
INSERT INTO public.profiles (id, email, full_name)
SELECT u.id, u.email, NULLIF(btrim(u.raw_user_meta_data ->> 'full_name'), '')
FROM auth.users u
ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;

-- Audit trail. Secrets, token hashes, Vault ids and raw provider payloads are
-- stripped. The actor comes from the verified JWT (auth.uid() / role) or, for
-- direct SQL sessions, from the database login role - never from row data.
CREATE FUNCTION private.audit_row_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_redact TEXT[] := ARRAY['token_hash', 'encrypted_access_token', 'encrypted_refresh_token',
                             'access_token_secret_id', 'refresh_token_secret_id', 'source_payload'];
    v_new JSONB;
    v_old JSONB;
    v_row JSONB;
    v_tenant UUID;
    v_actor UUID := (SELECT auth.uid());
    v_action UUID;
BEGIN
    IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW) - v_redact; END IF;
    IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD) - v_redact; END IF;
    v_row := COALESCE(v_new, v_old);
    v_tenant := CASE WHEN TG_TABLE_NAME = 'tenants' THEN v_row ->> 'id' ELSE v_row ->> 'tenant_id' END::UUID;

    -- No user JWT (service_role): attribute to the initiator of a privileged
    -- action bound to this transaction by private.use_privileged_action(),
    -- and only for rows of that action's tenant.
    IF v_actor IS NULL THEN
        v_action := private.try_uuid(current_setting('prisim.privileged_action_id', TRUE));
        IF v_action IS NOT NULL THEN
            SELECT a.actor_id INTO v_actor
            FROM private.privileged_actions a
            WHERE a.id = v_action AND a.tenant_id = v_tenant AND a.expires_at > NOW();
            IF v_actor IS NULL THEN
                v_action := NULL;
            END IF;
        END IF;
    END IF;

    INSERT INTO public.audit_logs (tenant_id, user_id, actor_role, action, entity_type, entity_id, details)
    VALUES (
        v_tenant,
        v_actor,
        COALESCE(NULLIF((SELECT auth.jwt() ->> 'role'), ''), session_user::TEXT),
        TG_TABLE_NAME || '.' || lower(TG_OP),
        TG_TABLE_NAME,
        COALESCE(v_row ->> 'id', v_row ->> 'connection_id', v_row ->> 'user_id')::UUID,
        jsonb_strip_nulls(jsonb_build_object('privileged_action_id', v_action))
            || jsonb_build_object('old', v_old, 'new', v_new)
    );
    RETURN NULL;
END;
$$;

CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE OR DELETE ON public.tenants            FOR EACH ROW EXECUTE FUNCTION private.audit_row_change();
CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE OR DELETE ON public.tenant_memberships FOR EACH ROW EXECUTE FUNCTION private.audit_row_change();
CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE OR DELETE ON public.tenant_invitations FOR EACH ROW EXECUTE FUNCTION private.audit_row_change();
CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE OR DELETE ON public.platform_admins    FOR EACH ROW EXECUTE FUNCTION private.audit_row_change();
CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE OR DELETE ON public.oauth_connections  FOR EACH ROW EXECUTE FUNCTION private.audit_row_change();
CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE OR DELETE ON private.oauth_credentials FOR EACH ROW EXECUTE FUNCTION private.audit_row_change();
CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE OR DELETE ON public.ad_accounts        FOR EACH ROW EXECUTE FUNCTION private.audit_row_change();
CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE OR DELETE ON public.reports            FOR EACH ROW EXECUTE FUNCTION private.audit_row_change();
CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE OR DELETE ON public.audit_scores       FOR EACH ROW EXECUTE FUNCTION private.audit_row_change();
CREATE TRIGGER audit_row_change AFTER INSERT OR DELETE           ON public.sync_jobs          FOR EACH ROW EXECUTE FUNCTION private.audit_row_change();
CREATE TRIGGER audit_row_change AFTER INSERT                     ON private.privileged_actions FOR EACH ROW EXECUTE FUNCTION private.audit_row_change();
CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE OR DELETE ON public.profiles         FOR EACH ROW EXECUTE FUNCTION private.audit_row_change();

-- Append-only, even for the table owner and the Dashboard SQL editor.
CREATE FUNCTION private.reject_audit_log_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER audit_logs_append_only
BEFORE UPDATE OR DELETE ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION private.reject_audit_log_change();
CREATE TRIGGER audit_logs_no_truncate
BEFORE TRUNCATE ON public.audit_logs
FOR EACH STATEMENT EXECUTE FUNCTION private.reject_audit_log_change();

REVOKE ALL ON FUNCTION
    private.purge_oauth_secrets(),
    private.set_updated_at(),
    private.handle_new_user(),
    private.handle_user_email_change(),
    private.audit_row_change(),
    private.reject_audit_log_change(),
    private.enforce_invitation_transition()
FROM PUBLIC;


-- -----------------------------------------------------
-- 13. RPC FUNCTIONS
-- -----------------------------------------------------
-- 13a. Session context for the frontend (callable by any signed-in user,
-- returns only the caller's own data). Suspended tenants are listed with
-- their status so the UI can explain why access is blocked.
CREATE FUNCTION public.get_my_context()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'user_id', (SELECT auth.uid()),
        'is_platform_admin', private.is_platform_admin(),
        -- Listed admin on an aal1 session: the UI must ask for the TOTP code.
        'platform_admin_mfa_required',
            private.is_listed_platform_admin() AND NOT private.is_platform_admin(),
        'memberships', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'tenant_id', t.id,
                       'business_name', t.business_name,
                       'slug', t.slug,
                       'tenant_status', t.status,
                       'role', tm.role
                   ) ORDER BY t.business_name)
            FROM public.tenant_memberships tm
            JOIN public.tenants t ON t.id = tm.tenant_id
            WHERE tm.user_id = (SELECT auth.uid())
              AND tm.status = 'active'
        ), '[]'::JSONB)
    );
$$;

-- 13b. Sanitized sync status for tenant members (no error messages, payloads
-- or internal identifiers).
CREATE FUNCTION public.get_tenant_sync_status(p_tenant_id UUID)
RETURNS TABLE (provider TEXT, last_status TEXT, last_run_at TIMESTAMPTZ, last_successful_sync_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT j.provider,
           (array_agg(j.status ORDER BY j.created_at DESC))[1],
           max(COALESCE(j.completed_at, j.started_at, j.scheduled_at)),
           max(j.completed_at) FILTER (WHERE j.status = 'completed')
    FROM public.sync_jobs j
    WHERE j.tenant_id = p_tenant_id
      AND (private.is_platform_admin() OR private.has_tenant_role(p_tenant_id, 'client'))
    GROUP BY j.provider
    ORDER BY j.provider;
$$;

-- 13c. Invitation acceptance by the invited, signed-in, e-mail-confirmed user.
CREATE FUNCTION public.accept_invitation(p_token TEXT)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid UUID := (SELECT auth.uid());
    v_email TEXT;
    v_inv public.tenant_invitations%ROWTYPE;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    IF p_token IS NULL OR char_length(p_token) < 32 THEN
        RAISE EXCEPTION 'Invitation is invalid or has expired' USING ERRCODE = '22023';
    END IF;

    SELECT lower(u.email) INTO v_email
    FROM auth.users u
    WHERE u.id = v_uid AND u.email_confirmed_at IS NOT NULL;

    IF v_email IS NULL THEN
        RAISE EXCEPTION 'E-mail address is not confirmed' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_inv
    FROM public.tenant_invitations i
    WHERE i.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
    FOR UPDATE;

    -- One generic message for every failure so tokens cannot be probed.
    IF NOT FOUND
       OR v_inv.status <> 'pending'
       OR v_inv.expires_at <= NOW()
       OR v_inv.email <> v_email
       OR NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = v_inv.tenant_id AND t.status = 'active')
    THEN
        RAISE EXCEPTION 'Invitation is invalid or has expired' USING ERRCODE = '22023';
    END IF;

    -- Never downgrade an existing active membership.
    INSERT INTO public.tenant_memberships AS tm (tenant_id, user_id, role, status)
    VALUES (v_inv.tenant_id, v_uid, v_inv.role, 'active')
    ON CONFLICT (tenant_id, user_id) DO UPDATE
    SET role = CASE
                   WHEN tm.status = 'active'
                    AND private.tenant_role_rank(tm.role) > private.tenant_role_rank(EXCLUDED.role)
                   THEN tm.role
                   ELSE EXCLUDED.role
               END,
        status = 'active';

    UPDATE public.tenant_invitations
    SET status = 'accepted', accepted_by = v_uid, accepted_at = NOW()
    WHERE id = v_inv.id;

    RETURN v_inv.tenant_id;
END;
$$;

-- 13c-2. Tenant user management.
-- These run with the caller's own JWT (browser or an Edge Function that
-- forwards the user's Authorization header), so authorization is decided
-- here, in SQL, and the audit trail records the real actor via auth.uid().
--   * platform admins (aal2): any tenant
--   * tenant owners: any member or role in their active tenant
--   * tenant admins: only manager/viewer/client members and roles
--   * a tenant always keeps at least one active owner

-- Returns 'platform_admin', 'owner' or 'admin', or raises 42501.
CREATE FUNCTION private.member_manager_role(p_tenant_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_role TEXT;
BEGIN
    IF (SELECT auth.uid()) IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    IF private.is_platform_admin() THEN
        IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant_id) THEN
            RAISE EXCEPTION 'Unknown tenant' USING ERRCODE = '22023';
        END IF;
        RETURN 'platform_admin';
    END IF;

    SELECT tm.role INTO v_role
    FROM public.tenant_memberships tm
    JOIN public.tenants t ON t.id = tm.tenant_id
    WHERE tm.tenant_id = p_tenant_id
      AND tm.user_id = (SELECT auth.uid())
      AND tm.status = 'active'
      AND t.status = 'active';

    IF v_role IN ('owner', 'admin') THEN
        RETURN v_role;
    END IF;
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
END;
$$;

-- Every tenant keeps at least one active owner. Enforced by trigger, so it
-- holds for every role and path: the RPCs below, platform admins writing the
-- table directly, service_role and SQL sessions alike. The only exceptions are
-- cascades from deleting the tenant itself or the owner's auth account.
CREATE FUNCTION private.protect_last_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- Only losing an active owner matters.
    IF NOT (OLD.role = 'owner' AND OLD.status = 'active') THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    IF TG_OP = 'UPDATE'
       AND NEW.role = 'owner' AND NEW.status = 'active'
       AND NEW.tenant_id = OLD.tenant_id AND NEW.user_id = OLD.user_id THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' AND (
           NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = OLD.tenant_id)
        OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.user_id)) THEN
        RETURN OLD;
    END IF;

    -- Serialize owner changes per tenant: two concurrent demotions of the
    -- last two owners cannot both succeed.
    PERFORM 1 FROM public.tenants t WHERE t.id = OLD.tenant_id FOR NO KEY UPDATE;

    IF NOT EXISTS (
        SELECT 1 FROM public.tenant_memberships tm
        WHERE tm.tenant_id = OLD.tenant_id
          AND tm.id <> OLD.id
          AND tm.role = 'owner'
          AND tm.status = 'active'
    ) THEN
        RAISE EXCEPTION 'A tenant must keep at least one active owner' USING ERRCODE = '23514';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER protect_last_owner
BEFORE UPDATE OR DELETE ON public.tenant_memberships
FOR EACH ROW EXECUTE FUNCTION private.protect_last_owner();

REVOKE ALL ON FUNCTION
    private.member_manager_role(UUID),
    private.protect_last_owner()
FROM PUBLIC;

-- Creates an invitation and returns the raw token ONCE. Only its SHA-256
-- hash is stored. The token is 256 bits from the database CSPRNG, so its
-- strength never depends on the caller. Re-inviting the same e-mail replaces
-- the previous pending invitation (resend).
CREATE FUNCTION public.create_invitation(p_tenant_id UUID, p_email TEXT, p_role TEXT DEFAULT 'client')
RETURNS TABLE (invitation_id UUID, invitation_token TEXT, invitation_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid UUID := (SELECT auth.uid());
    v_manager TEXT;
    v_email TEXT := lower(btrim(p_email));
    v_token TEXT;
    v_id UUID;
    v_expires TIMESTAMPTZ;
BEGIN
    v_manager := private.member_manager_role(p_tenant_id);

    IF private.tenant_role_rank(p_role) = 0 THEN
        RAISE EXCEPTION 'Unknown role' USING ERRCODE = '22023';
    END IF;
    IF v_manager = 'admin' AND private.tenant_role_rank(p_role) >= private.tenant_role_rank('admin') THEN
        RAISE EXCEPTION 'Only owners can invite owners or admins' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant_id AND t.status = 'active') THEN
        RAISE EXCEPTION 'Tenant is not active' USING ERRCODE = '22023';
    END IF;

    -- Abuse brake for a compromised or misbehaving account.
    IF (SELECT count(*) FROM public.tenant_invitations i
        WHERE i.invited_by = v_uid AND i.created_at > NOW() - INTERVAL '1 hour') >= 30 THEN
        RAISE EXCEPTION 'Too many invitations, try again later' USING ERRCODE = '53400';
    END IF;

    -- Close any earlier pending invitation for this address (expired or not).
    UPDATE public.tenant_invitations i
    SET status = CASE WHEN i.expires_at <= NOW() THEN 'expired' ELSE 'revoked' END
    WHERE i.tenant_id = p_tenant_id AND i.email = v_email AND i.status = 'pending';

    v_token := encode(extensions.gen_random_bytes(32), 'hex');

    INSERT INTO public.tenant_invitations (tenant_id, email, role, token_hash, invited_by)
    VALUES (p_tenant_id, v_email, p_role, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), v_uid)
    RETURNING id, expires_at INTO v_id, v_expires;

    RETURN QUERY SELECT v_id, v_token, v_expires;
END;
$$;

CREATE FUNCTION public.revoke_invitation(p_invitation_id UUID)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_inv public.tenant_invitations%ROWTYPE;
BEGIN
    SELECT * INTO v_inv FROM public.tenant_invitations i WHERE i.id = p_invitation_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
    END IF;
    PERFORM private.member_manager_role(v_inv.tenant_id);

    IF v_inv.status <> 'pending' THEN
        RAISE EXCEPTION 'Invitation is not pending' USING ERRCODE = '22023';
    END IF;
    UPDATE public.tenant_invitations SET status = 'revoked' WHERE id = v_inv.id;
END;
$$;

CREATE FUNCTION public.change_member_role(p_tenant_id UUID, p_user_id UUID, p_role TEXT)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_manager TEXT;
    v_target public.tenant_memberships%ROWTYPE;
BEGIN
    v_manager := private.member_manager_role(p_tenant_id);

    IF private.tenant_role_rank(p_role) = 0 THEN
        RAISE EXCEPTION 'Unknown role' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_target FROM public.tenant_memberships tm
    WHERE tm.tenant_id = p_tenant_id AND tm.user_id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Membership not found' USING ERRCODE = '22023';
    END IF;

    IF v_manager = 'admin' AND (
           private.tenant_role_rank(v_target.role) >= private.tenant_role_rank('admin')
        OR private.tenant_role_rank(p_role) >= private.tenant_role_rank('admin')) THEN
        RAISE EXCEPTION 'Only owners can manage owners and admins' USING ERRCODE = '42501';
    END IF;

    -- Last-owner protection: trigger private.protect_last_owner().
    UPDATE public.tenant_memberships SET role = p_role WHERE id = v_target.id;
END;
$$;

-- Deactivates a member and revokes their pending invitations to this tenant,
-- so an old invitation e-mail cannot silently restore access.
CREATE FUNCTION public.deactivate_member(p_tenant_id UUID, p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_manager TEXT;
    v_target public.tenant_memberships%ROWTYPE;
BEGIN
    v_manager := private.member_manager_role(p_tenant_id);

    SELECT * INTO v_target FROM public.tenant_memberships tm
    WHERE tm.tenant_id = p_tenant_id AND tm.user_id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Membership not found' USING ERRCODE = '22023';
    END IF;

    IF v_manager = 'admin' AND private.tenant_role_rank(v_target.role) >= private.tenant_role_rank('admin') THEN
        RAISE EXCEPTION 'Only owners can manage owners and admins' USING ERRCODE = '42501';
    END IF;
    -- Last-owner protection: trigger private.protect_last_owner().
    UPDATE public.tenant_memberships SET status = 'inactive' WHERE id = v_target.id;

    UPDATE public.tenant_invitations i
    SET status = 'revoked'
    WHERE i.tenant_id = p_tenant_id
      AND i.status = 'pending'
      AND i.email = (SELECT lower(u.email) FROM auth.users u WHERE u.id = p_user_id);
END;
$$;

-- Marks overdue pending invitations as expired. service_role only; run it on
-- a schedule (Edge Function cron or pg_cron). Returns the number expired.
CREATE FUNCTION public.expire_stale_invitations()
RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    UPDATE public.tenant_invitations
    SET status = 'expired'
    WHERE status = 'pending' AND expires_at <= NOW();
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- 13c-3. Start a privileged action (see section 11b). Called with the user's
-- own JWT. Managers, admins and owners of an active tenant, or aal2 platform
-- admins. Returns an id the Edge Function passes to the service_role RPC.
CREATE FUNCTION public.begin_privileged_action(p_tenant_id UUID, p_action TEXT, p_target_id UUID DEFAULT NULL)
RETURNS TABLE (action_id UUID, action_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid UUID := (SELECT auth.uid());
    v_authority TEXT;
    v_id UUID;
    v_expires TIMESTAMPTZ;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF p_action IS NULL OR p_action NOT IN ('oauth.connect', 'oauth.disconnect', 'sync.start', 'report.generate') THEN
        RAISE EXCEPTION 'Unknown action' USING ERRCODE = '22023';
    END IF;

    IF private.is_platform_admin() THEN
        IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant_id) THEN
            RAISE EXCEPTION 'Unknown tenant' USING ERRCODE = '22023';
        END IF;
        v_authority := 'platform_admin';
    ELSE
        SELECT tm.role INTO v_authority
        FROM public.tenant_memberships tm
        JOIN public.tenants t ON t.id = tm.tenant_id
        WHERE tm.tenant_id = p_tenant_id
          AND tm.user_id = v_uid
          AND tm.status = 'active'
          AND t.status = 'active';
        IF private.tenant_role_rank(v_authority) < private.tenant_role_rank('manager') THEN
            RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
        END IF;
    END IF;

    -- Targets must exist in the same tenant.
    IF p_action IN ('oauth.disconnect', 'sync.start') THEN
        IF p_target_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM public.oauth_connections c WHERE c.id = p_target_id AND c.tenant_id = p_tenant_id) THEN
            RAISE EXCEPTION 'Unknown connection' USING ERRCODE = '22023';
        END IF;
    ELSIF p_action = 'report.generate' THEN
        IF p_target_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.reports r WHERE r.id = p_target_id AND r.tenant_id = p_tenant_id) THEN
            RAISE EXCEPTION 'Unknown report' USING ERRCODE = '22023';
        END IF;
    ELSIF p_target_id IS NOT NULL THEN
        RAISE EXCEPTION 'oauth.connect takes no target' USING ERRCODE = '22023';
    END IF;

    IF (SELECT count(*) FROM private.privileged_actions a
        WHERE a.actor_id = v_uid AND a.created_at > NOW() - INTERVAL '1 hour') >= 60 THEN
        RAISE EXCEPTION 'Too many requests, try again later' USING ERRCODE = '53400';
    END IF;

    INSERT INTO private.privileged_actions (tenant_id, actor_id, actor_authority, action, target_id)
    VALUES (p_tenant_id, v_uid, v_authority, p_action, p_target_id)
    RETURNING id, expires_at INTO v_id, v_expires;

    RETURN QUERY SELECT v_id, v_expires;
END;
$$;

-- 13d. Token vault RPCs - service_role (Edge Functions) only.

-- Update a Vault secret in place, or create it when it does not exist yet or
-- its id is dangling. A leftover secret with the same name (e.g. from an
-- interrupted earlier run) is unreferenced by definition and is removed first.
CREATE FUNCTION private.upsert_oauth_secret(p_secret_id UUID, p_value TEXT, p_name TEXT)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_secret_id IS NOT NULL AND EXISTS (SELECT 1 FROM vault.secrets WHERE id = p_secret_id) THEN
        PERFORM vault.update_secret(p_secret_id, p_value);
        RETURN p_secret_id;
    END IF;
    DELETE FROM vault.secrets WHERE name = p_name;
    RETURN vault.create_secret(p_value, p_name);
END;
$$;
REVOKE ALL ON FUNCTION private.upsert_oauth_secret(UUID, TEXT, TEXT) FROM PUBLIC;

CREATE FUNCTION public.store_oauth_tokens(
    p_connection_id UUID,
    p_access_token TEXT,
    p_refresh_token TEXT DEFAULT NULL,
    p_expires_at TIMESTAMPTZ DEFAULT NULL,
    -- Required for a user-initiated connect (OAuth callback): an
    -- 'oauth.connect' action. NULL only for automatic background refreshes.
    p_action_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_tenant UUID;
    v_tenant_status TEXT;
    v_cred private.oauth_credentials%ROWTYPE;
    v_access UUID;
    v_refresh UUID;
BEGIN
    SELECT c.tenant_id, t.status INTO v_tenant, v_tenant_status
    FROM public.oauth_connections c
    JOIN public.tenants t ON t.id = c.tenant_id
    WHERE c.id = p_connection_id
    FOR UPDATE OF c;
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'Unknown OAuth connection' USING ERRCODE = '22023';
    END IF;
    IF v_tenant_status <> 'active' THEN
        RAISE EXCEPTION 'Tenant is not active' USING ERRCODE = '22023';
    END IF;
    IF p_action_id IS NOT NULL THEN
        PERFORM private.use_privileged_action(p_action_id, 'oauth.connect', v_tenant, p_connection_id);
    END IF;

    -- Every store or refresh carries a new access token.
    IF p_access_token IS NULL OR btrim(p_access_token) = '' THEN
        RAISE EXCEPTION 'An access token is required' USING ERRCODE = '22023';
    END IF;
    -- NULL keeps the existing refresh token (Google returns one only on first
    -- consent); an empty string is always a caller bug.
    IF p_refresh_token IS NOT NULL AND btrim(p_refresh_token) = '' THEN
        RAISE EXCEPTION 'Refresh token must be NULL or non-empty' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_cred FROM private.oauth_credentials WHERE connection_id = p_connection_id FOR UPDATE;

    v_access := private.upsert_oauth_secret(
        v_cred.access_token_secret_id, p_access_token, 'oauth:' || p_connection_id || ':access');

    v_refresh := v_cred.refresh_token_secret_id;
    IF p_refresh_token IS NOT NULL THEN
        v_refresh := private.upsert_oauth_secret(
            v_refresh, p_refresh_token, 'oauth:' || p_connection_id || ':refresh');
    END IF;

    INSERT INTO private.oauth_credentials
        (connection_id, tenant_id, access_token_secret_id, refresh_token_secret_id, token_expires_at)
    VALUES (p_connection_id, v_tenant, v_access, v_refresh, p_expires_at)
    ON CONFLICT (connection_id) DO UPDATE
    SET access_token_secret_id = EXCLUDED.access_token_secret_id,
        refresh_token_secret_id = EXCLUDED.refresh_token_secret_id,
        token_expires_at = EXCLUDED.token_expires_at;

    UPDATE public.oauth_connections
    SET token_expires_at = p_expires_at, status = 'connected'
    WHERE id = p_connection_id;
END;
$$;

CREATE FUNCTION public.get_oauth_tokens(p_connection_id UUID)
RETURNS TABLE (access_token TEXT, refresh_token TEXT, expires_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT a.decrypted_secret, r.decrypted_secret, c.token_expires_at
    FROM private.oauth_credentials c
    LEFT JOIN vault.decrypted_secrets a ON a.id = c.access_token_secret_id
    LEFT JOIN vault.decrypted_secrets r ON r.id = c.refresh_token_secret_id
    WHERE c.connection_id = p_connection_id;
$$;

-- p_action_id: an 'oauth.disconnect' action for this connection when a user
-- disconnects; NULL only for system clean-up (e.g. provider-side revocation).
CREATE FUNCTION public.delete_oauth_tokens(p_connection_id UUID, p_action_id UUID DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_tenant UUID;
BEGIN
    IF p_action_id IS NOT NULL THEN
        SELECT c.tenant_id INTO v_tenant FROM public.oauth_connections c WHERE c.id = p_connection_id;
        PERFORM private.use_privileged_action(p_action_id, 'oauth.disconnect', v_tenant, p_connection_id);
    END IF;

    DELETE FROM private.oauth_credentials WHERE connection_id = p_connection_id;
    UPDATE public.oauth_connections
    SET status = 'revoked', token_expires_at = NULL
    WHERE id = p_connection_id;
END;
$$;

-- 13e. Other service_role workflows that act for a user. Each requires a
-- privileged action, so the change is attributed to the initiating user.

-- OAuth start: create the pending connection row.
CREATE FUNCTION public.create_oauth_connection(p_action_id UUID, p_tenant_id UUID, p_provider TEXT)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_id UUID;
BEGIN
    PERFORM private.use_privileged_action(p_action_id, 'oauth.connect', p_tenant_id, NULL);
    IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant_id AND t.status = 'active') THEN
        RAISE EXCEPTION 'Tenant is not active' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.oauth_connections (tenant_id, provider, status)
    VALUES (p_tenant_id, p_provider, 'pending')
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

-- Manual sync: queue one job for a connected connection.
CREATE FUNCTION public.start_sync_job(p_action_id UUID, p_connection_id UUID, p_job_type TEXT DEFAULT 'manual_sync')
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_conn public.oauth_connections%ROWTYPE;
    v_id UUID;
BEGIN
    SELECT * INTO v_conn FROM public.oauth_connections c WHERE c.id = p_connection_id FOR UPDATE;
    PERFORM private.use_privileged_action(p_action_id, 'sync.start', v_conn.tenant_id, p_connection_id);

    IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = v_conn.tenant_id AND t.status = 'active') THEN
        RAISE EXCEPTION 'Tenant is not active' USING ERRCODE = '22023';
    END IF;
    IF v_conn.status <> 'connected' THEN
        RAISE EXCEPTION 'Connection is not connected' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.sync_jobs j
               WHERE j.connection_id = p_connection_id AND j.status IN ('pending', 'processing')) THEN
        RAISE EXCEPTION 'A sync is already queued or running for this connection' USING ERRCODE = '55006';
    END IF;

    INSERT INTO public.sync_jobs (tenant_id, connection_id, provider, job_type, status)
    VALUES (v_conn.tenant_id, p_connection_id, v_conn.provider, p_job_type, 'pending')
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;


-- -----------------------------------------------------
-- 14. ROW LEVEL SECURITY POLICIES
-- -----------------------------------------------------
-- Convention per table:
--   "Platform admins manage <table>"  FOR ALL    -> PRISIM staff
--   "Members read <table>"            FOR SELECT -> tenant users by role
-- Tenant users have no direct write policies (except their own profile);
-- tenant-scoped mutations go through Edge Functions that check roles.

-- Replace the 202611050001 policies (the profile self-read policy is kept).
DROP POLICY IF EXISTS "Members can view their tenants"       ON public.tenants;
DROP POLICY IF EXISTS "Members can view tenant memberships"  ON public.tenant_memberships;
DROP POLICY IF EXISTS "Members can view ad accounts"         ON public.ad_accounts;
DROP POLICY IF EXISTS "Members can view campaigns"           ON public.campaigns;
DROP POLICY IF EXISTS "Members can view daily metrics"       ON public.daily_metrics;
DROP POLICY IF EXISTS "Members can view audit scores"        ON public.audit_scores;
DROP POLICY IF EXISTS "Members can view sync jobs"           ON public.sync_jobs;
DROP POLICY IF EXISTS "Members can view sync logs"           ON public.sync_logs;
DROP POLICY IF EXISTS "Members can view reports"             ON public.reports;

-- platform_admins: read own row; admins read all. No API writes.
CREATE POLICY "Read own or all platform admins" ON public.platform_admins
FOR SELECT TO authenticated
USING (user_id = (SELECT auth.uid()) OR (SELECT private.is_platform_admin()));

-- tenants
CREATE POLICY "Platform admins manage tenants" ON public.tenants
FOR ALL TO authenticated
USING ((SELECT private.is_platform_admin())) WITH CHECK ((SELECT private.is_platform_admin()));
CREATE POLICY "Members read active tenants" ON public.tenants
FOR SELECT TO authenticated
USING (id IN (SELECT private.my_tenant_ids('client')));

-- profiles ("Users can view own profile" from 202611050001 is kept)
CREATE POLICY "Users update own profile" ON public.profiles
FOR UPDATE TO authenticated
USING (id = (SELECT auth.uid())) WITH CHECK (id = (SELECT auth.uid()));
CREATE POLICY "Platform admins read profiles" ON public.profiles
FOR SELECT TO authenticated
USING ((SELECT private.is_platform_admin()));
CREATE POLICY "Tenant managers read member profiles" ON public.profiles
FOR SELECT TO authenticated
USING (private.can_view_profile(id));

-- tenant_memberships
CREATE POLICY "Platform admins manage memberships" ON public.tenant_memberships
FOR ALL TO authenticated
USING ((SELECT private.is_platform_admin())) WITH CHECK ((SELECT private.is_platform_admin()));
CREATE POLICY "Users read own memberships" ON public.tenant_memberships
FOR SELECT TO authenticated
USING (user_id = (SELECT auth.uid()));
CREATE POLICY "Tenant admins read tenant memberships" ON public.tenant_memberships
FOR SELECT TO authenticated
USING (tenant_id IN (SELECT private.my_tenant_ids('admin')));

-- tenant_invitations: read-only through the API. All changes go through
-- create_invitation / revoke_invitation / accept_invitation.
CREATE POLICY "Platform admins read invitations" ON public.tenant_invitations
FOR SELECT TO authenticated
USING ((SELECT private.is_platform_admin()));
CREATE POLICY "Tenant admins read invitations" ON public.tenant_invitations
FOR SELECT TO authenticated
USING (tenant_id IN (SELECT private.my_tenant_ids('admin')));

-- oauth_connections (token columns are additionally hidden by column grants)
CREATE POLICY "Platform admins manage connections" ON public.oauth_connections
FOR ALL TO authenticated
USING ((SELECT private.is_platform_admin())) WITH CHECK ((SELECT private.is_platform_admin()));
CREATE POLICY "Tenant managers read connections" ON public.oauth_connections
FOR SELECT TO authenticated
USING (tenant_id IN (SELECT private.my_tenant_ids('manager')));

-- Client-visible business data
CREATE POLICY "Platform admins manage ad accounts" ON public.ad_accounts
FOR ALL TO authenticated
USING ((SELECT private.is_platform_admin())) WITH CHECK ((SELECT private.is_platform_admin()));
CREATE POLICY "Members read ad accounts" ON public.ad_accounts
FOR SELECT TO authenticated
USING (tenant_id IN (SELECT private.my_tenant_ids('client')));

CREATE POLICY "Platform admins manage campaigns" ON public.campaigns
FOR ALL TO authenticated
USING ((SELECT private.is_platform_admin())) WITH CHECK ((SELECT private.is_platform_admin()));
CREATE POLICY "Members read campaigns" ON public.campaigns
FOR SELECT TO authenticated
USING (tenant_id IN (SELECT private.my_tenant_ids('client')));

CREATE POLICY "Platform admins manage daily metrics" ON public.daily_metrics
FOR ALL TO authenticated
USING ((SELECT private.is_platform_admin())) WITH CHECK ((SELECT private.is_platform_admin()));
CREATE POLICY "Members read daily metrics" ON public.daily_metrics
FOR SELECT TO authenticated
USING (tenant_id IN (SELECT private.my_tenant_ids('client')));

CREATE POLICY "Platform admins manage audit scores" ON public.audit_scores
FOR ALL TO authenticated
USING ((SELECT private.is_platform_admin())) WITH CHECK ((SELECT private.is_platform_admin()));
CREATE POLICY "Members read audit scores" ON public.audit_scores
FOR SELECT TO authenticated
USING (tenant_id IN (SELECT private.my_tenant_ids('client')));

CREATE POLICY "Platform admins manage reports" ON public.reports
FOR ALL TO authenticated
USING ((SELECT private.is_platform_admin())) WITH CHECK ((SELECT private.is_platform_admin()));
CREATE POLICY "Members read reports" ON public.reports
FOR SELECT TO authenticated
USING (tenant_id IN (SELECT private.my_tenant_ids('client')));

-- Internal operational data: platform admins only.
CREATE POLICY "Platform admins manage sync jobs" ON public.sync_jobs
FOR ALL TO authenticated
USING ((SELECT private.is_platform_admin())) WITH CHECK ((SELECT private.is_platform_admin()));
CREATE POLICY "Platform admins read sync logs" ON public.sync_logs
FOR SELECT TO authenticated
USING ((SELECT private.is_platform_admin()));

-- Audit trail: read-only; tenant owners/admins see their tenant's entries.
CREATE POLICY "Platform admins read audit logs" ON public.audit_logs
FOR SELECT TO authenticated
USING ((SELECT private.is_platform_admin()));
CREATE POLICY "Tenant admins read tenant audit logs" ON public.audit_logs
FOR SELECT TO authenticated
USING (tenant_id IN (SELECT private.my_tenant_ids('admin')));


-- -----------------------------------------------------
-- 15. EXPLICIT PRIVILEGES
-- -----------------------------------------------------
-- Start from zero for API roles, then grant exactly what the policies need.
-- service_role keeps its Supabase defaults (Edge Functions only).
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- Read access (rows still filtered by RLS)
GRANT SELECT ON
    public.tenants,
    public.profiles,
    public.platform_admins,
    public.tenant_memberships,
    public.ad_accounts,
    public.campaigns,
    public.audit_scores,
    public.reports,
    public.sync_jobs,
    public.sync_logs,
    public.audit_logs
TO authenticated;

-- daily_metrics: the raw provider payload stays server-side. Clients must
-- select explicit columns (select('*') is rejected).
GRANT SELECT (id, tenant_id, ad_account_id, campaign_id, metric_date, impressions,
              reach, clicks, spend, conversions, currency, created_at)
    ON public.daily_metrics TO authenticated;

-- Writes - only platform-admin RLS policies allow them. Tenants cannot be
-- deleted through the API (deactivate or suspend instead).
GRANT INSERT, UPDATE ON public.tenants TO authenticated;
GRANT INSERT, UPDATE, DELETE ON
    public.tenant_memberships,
    public.ad_accounts,
    public.campaigns,
    public.daily_metrics,
    public.audit_scores,
    public.reports,
    public.sync_jobs
TO authenticated;

-- Profiles: users may change only their display fields.
GRANT UPDATE (full_name, avatar_url) ON public.profiles TO authenticated;

-- OAuth connections: token columns are never readable through the API.
GRANT SELECT (id, tenant_id, provider, provider_account_id, account_name,
              token_expires_at, scopes, status, created_at, updated_at)
    ON public.oauth_connections TO authenticated;
GRANT UPDATE (status) ON public.oauth_connections TO authenticated;
GRANT DELETE ON public.oauth_connections TO authenticated;

-- Invitations: read-only; the token hash is never readable through the API.
GRANT SELECT (id, tenant_id, email, role, status, invited_by, accepted_by,
              expires_at, accepted_at, created_at, updated_at)
    ON public.tenant_invitations TO authenticated;

-- Audit trail: written only by the audit trigger (SECURITY DEFINER, owned by
-- postgres). Edge Functions can read it but cannot insert, forge or alter it.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.audit_logs FROM service_role;

-- Functions: nothing is callable by anon. The authenticated allowlist is
-- asserted by supabase/tests/database/07_catalog.test.sql.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
    public.is_tenant_member(UUID),
    public.get_my_context(),
    public.get_tenant_sync_status(UUID),
    public.accept_invitation(TEXT),
    public.create_invitation(UUID, TEXT, TEXT),
    public.revoke_invitation(UUID),
    public.change_member_role(UUID, UUID, TEXT),
    public.deactivate_member(UUID, UUID),
    public.begin_privileged_action(UUID, TEXT, UUID)
TO authenticated;

GRANT EXECUTE ON FUNCTION
    public.store_oauth_tokens(UUID, TEXT, TEXT, TIMESTAMPTZ, UUID),
    public.get_oauth_tokens(UUID),
    public.delete_oauth_tokens(UUID, UUID),
    public.create_oauth_connection(UUID, UUID, TEXT),
    public.start_sync_job(UUID, UUID, TEXT),
    public.expire_stale_invitations()
TO service_role;

-- Future objects created by `postgres` in public need explicit grants.
-- (This reverses Supabase's per-schema auto-grants. PostgreSQL's built-in
-- EXECUTE-to-PUBLIC on new functions cannot be removed per schema, so every
-- future function must still `REVOKE ALL ... FROM PUBLIC, anon` itself;
-- supabase/tests/database/01_structure.test.sql fails if one is missed.)
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;


-- -----------------------------------------------------
-- 16. STORAGE: PRIVATE REPORTS BUCKET
-- -----------------------------------------------------
-- Object path convention: <tenant_id>/<report_id>.<ext>
-- Edge Functions upload with service_role; browsers download via signed URLs
-- or authenticated reads allowed by the policies below.
-- Upsert: a pre-existing `reports` bucket (e.g. created as public in the
-- Dashboard) is forced private with the intended limits.
CREATE FUNCTION private.ensure_reports_bucket()
RETURNS VOID
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
        'reports',
        'reports',
        FALSE,
        20971520, -- 20 MiB
        ARRAY[
            'application/pdf',
            'text/csv',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        ]
    )
    ON CONFLICT (id) DO UPDATE
    SET public             = FALSE,
        file_size_limit    = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;
$$;
REVOKE ALL ON FUNCTION private.ensure_reports_bucket() FROM PUBLIC;

SELECT private.ensure_reports_bucket();

CREATE POLICY "reports: tenant members read own folder" ON storage.objects
FOR SELECT TO authenticated
USING (bucket_id = 'reports' AND private.can_read_tenant_object(name));

CREATE POLICY "reports: platform admins upload" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'reports' AND (SELECT private.is_platform_admin()));

CREATE POLICY "reports: platform admins update" ON storage.objects
FOR UPDATE TO authenticated
USING (bucket_id = 'reports' AND (SELECT private.is_platform_admin()))
WITH CHECK (bucket_id = 'reports' AND (SELECT private.is_platform_admin()));

CREATE POLICY "reports: platform admins delete" ON storage.objects
FOR DELETE TO authenticated
USING (bucket_id = 'reports' AND (SELECT private.is_platform_admin()));


-- -----------------------------------------------------
-- 17. DOCUMENTATION COMMENTS
-- -----------------------------------------------------
COMMENT ON FUNCTION public.get_my_context() IS
    'Caller''s platform-admin flag and active memberships (incl. tenant status).';
COMMENT ON FUNCTION public.get_tenant_sync_status(UUID) IS
    'Sanitized per-provider sync status for tenant members. No error details.';
COMMENT ON FUNCTION public.accept_invitation(TEXT) IS
    'Accept a tenant invitation using the raw token from the invite e-mail.';
COMMENT ON FUNCTION public.create_invitation(UUID, TEXT, TEXT) IS
    'Owner/admin (or aal2 platform admin) creates an invitation; returns the raw token once.';
COMMENT ON FUNCTION public.revoke_invitation(UUID) IS
    'Owner/admin (or aal2 platform admin) revokes a pending invitation.';
COMMENT ON FUNCTION public.change_member_role(UUID, UUID, TEXT) IS
    'Owner/admin (or aal2 platform admin) changes a member role; keeps one active owner.';
COMMENT ON FUNCTION public.deactivate_member(UUID, UUID) IS
    'Owner/admin (or aal2 platform admin) deactivates a member and revokes their pending invitations.';
COMMENT ON FUNCTION public.expire_stale_invitations() IS
    'service_role only. Marks overdue pending invitations as expired.';
COMMENT ON FUNCTION public.begin_privileged_action(UUID, TEXT, UUID) IS
    'Manager+ (or aal2 platform admin) authorizes a service_role workflow; returns an action id for attribution.';
COMMENT ON FUNCTION public.store_oauth_tokens(UUID, TEXT, TEXT, TIMESTAMPTZ, UUID) IS
    'service_role only. Stores/rotates OAuth tokens in Supabase Vault. Pass an oauth.connect action id for user-initiated connects.';
COMMENT ON FUNCTION public.get_oauth_tokens(UUID) IS
    'service_role only. Returns decrypted OAuth tokens for a connection. Never return the result to a browser.';
COMMENT ON FUNCTION public.delete_oauth_tokens(UUID, UUID) IS
    'service_role only. Deletes Vault secrets and marks the connection revoked. Pass an oauth.disconnect action id for user-initiated disconnects.';
COMMENT ON FUNCTION public.create_oauth_connection(UUID, UUID, TEXT) IS
    'service_role only. Creates a pending connection for an oauth.connect action.';
COMMENT ON FUNCTION public.start_sync_job(UUID, UUID, TEXT) IS
    'service_role only. Queues a sync for a sync.start action; one queued/running job per connection.';

-- Security hardening completed.
