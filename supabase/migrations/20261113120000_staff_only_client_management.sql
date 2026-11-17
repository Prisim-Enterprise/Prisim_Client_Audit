-- =====================================================
-- 20261113120000 - Staff-only client management
--
-- Business rule: client onboarding, client user accounts, roles, access and
-- advertising-account connections are managed exclusively by PRISIM staff
-- (aal2 platform admins) in the staff portal. Client users (owner, admin,
-- manager, viewer, client) only read their own analytics, published audits,
-- shared reports, sync status, tenant and own membership/profile.
--
-- Direct table writes were already staff-only (every write policy requires
-- private.is_platform_admin()). This migration closes the remaining client
-- paths, which ran through SECURITY DEFINER functions and read policies:
--
--   1. private.member_manager_role      owner/admin  -> aal2 platform admin only
--      (used by change_member_role, deactivate_member, revoke_invitation)
--   2. public.begin_privileged_action   manager+     -> aal2 platform admin only
--      (oauth.connect, oauth.disconnect, sync.start, report.generate)
--   3. private.use_privileged_action    accepts only actions started by a
--      platform admin (rejects manager actions still within their 15 min)
--   4. public.set_ad_account_sync       manager+     -> aal2 platform admin only
--   5. public.get_tenant_members        admin+       -> aal2 platform admin only
--   6. public.accept_invitation         no API role may execute it (retired)
--   7. drops five client read policies the client portal no longer uses:
--      tenant memberships, invitations, audit logs (admin+), connections and
--      member profiles (manager+)
--
-- Unchanged: tenant isolation, all staff write policies, private.is_platform_admin
-- (listed + aal2), audit triggers, last-owner protection, Vault token RPCs,
-- storage policies, scheduled jobs, client read access to business data and
-- "Users update own profile" (full_name, avatar_url).
--
-- No table, column or data changes. Every statement is idempotent
-- (CREATE OR REPLACE with unchanged signatures keeps existing grants;
-- DROP POLICY IF EXISTS).
-- =====================================================


-- -----------------------------------------------------
-- 1. Member management: aal2 platform admins only
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION private.member_manager_role(p_tenant_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF (SELECT auth.uid()) IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    -- Client owners and admins no longer manage members: PRISIM staff do.
    IF NOT private.is_platform_admin() THEN
        RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant_id) THEN
        RAISE EXCEPTION 'Unknown tenant' USING ERRCODE = '22023';
    END IF;
    RETURN 'platform_admin';
END;
$$;
REVOKE ALL ON FUNCTION private.member_manager_role(UUID) FROM PUBLIC;


-- -----------------------------------------------------
-- 2. Privileged actions: started only by aal2 platform admins
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.begin_privileged_action(p_tenant_id UUID, p_action TEXT, p_target_id UUID DEFAULT NULL)
RETURNS TABLE (action_id UUID, action_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid UUID := (SELECT auth.uid());
    v_id UUID;
    v_expires TIMESTAMPTZ;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF p_action IS NULL OR p_action NOT IN ('oauth.connect', 'oauth.disconnect', 'sync.start', 'report.generate', 'invitation.create') THEN
        RAISE EXCEPTION 'Unknown action' USING ERRCODE = '22023';
    END IF;

    -- Connections, syncs, reports and invitations are staff operations.
    IF NOT private.is_platform_admin() THEN
        RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant_id) THEN
        RAISE EXCEPTION 'Unknown tenant' USING ERRCODE = '22023';
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
        RAISE EXCEPTION 'This action takes no target' USING ERRCODE = '22023';
    END IF;

    IF (SELECT count(*) FROM private.privileged_actions a
        WHERE a.actor_id = v_uid AND a.created_at > NOW() - INTERVAL '1 hour') >= 60 THEN
        RAISE EXCEPTION 'Too many requests, try again later' USING ERRCODE = '53400';
    END IF;

    INSERT INTO private.privileged_actions (tenant_id, actor_id, actor_authority, action, target_id)
    VALUES (p_tenant_id, v_uid, 'platform_admin', p_action, p_target_id)
    RETURNING id, expires_at INTO v_id, v_expires;

    RETURN QUERY SELECT v_id, v_expires;
END;
$$;


-- -----------------------------------------------------
-- 3. Consuming an action (service_role RPCs): platform-admin actions only.
--    service_role calls carry no user JWT, so the initiator is re-checked
--    against platform_admins (aal2 was enforced when the action began).
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION private.use_privileged_action(
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
       OR v_act.target_id IS DISTINCT FROM p_target_id
       -- Actions started by tenant members before this migration are void.
       OR v_act.actor_authority <> 'platform_admin'
       -- The initiator must still be a platform admin.
       OR NOT EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = v_act.actor_id)
    THEN
        RAISE EXCEPTION 'Privileged action is invalid or has expired' USING ERRCODE = '42501';
    END IF;

    UPDATE private.privileged_actions SET last_used_at = NOW() WHERE id = v_act.id;
    PERFORM set_config('prisim.privileged_action_id', v_act.id::TEXT, TRUE);
    RETURN v_act.actor_id;
END;
$$;
REVOKE ALL ON FUNCTION private.use_privileged_action(UUID, TEXT, UUID, UUID) FROM PUBLIC;


-- -----------------------------------------------------
-- 4. Ad account selection: aal2 platform admins only
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_ad_account_sync(p_connection_id UUID, p_ad_account_ids UUID[])
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
    IF NOT private.is_platform_admin() THEN
        RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
    END IF;
    SELECT c.tenant_id INTO v_tenant FROM public.oauth_connections c WHERE c.id = p_connection_id;
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'Unknown connection' USING ERRCODE = '22023';
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


-- -----------------------------------------------------
-- 5. Member directory: aal2 platform admins only
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_tenant_members(p_tenant_id UUID)
RETURNS TABLE (
    user_id UUID, email TEXT, full_name TEXT, role TEXT, status TEXT,
    created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT private.is_platform_admin() THEN
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


-- -----------------------------------------------------
-- 6. Invitation acceptance is retired: accounts are created by staff
--    (Edge Function manage-tenant-user). No API role may call it.
-- -----------------------------------------------------
REVOKE ALL ON FUNCTION public.accept_invitation(TEXT) FROM PUBLIC, anon, authenticated, service_role;


-- -----------------------------------------------------
-- 7. Client read policies the client portal no longer needs
-- -----------------------------------------------------
DROP POLICY IF EXISTS "Tenant admins read tenant memberships" ON public.tenant_memberships;
DROP POLICY IF EXISTS "Tenant admins read invitations" ON public.tenant_invitations;
DROP POLICY IF EXISTS "Tenant admins read tenant audit logs" ON public.audit_logs;
DROP POLICY IF EXISTS "Tenant managers read connections" ON public.oauth_connections;
DROP POLICY IF EXISTS "Tenant managers read member profiles" ON public.profiles;


-- -----------------------------------------------------
-- Documentation
-- -----------------------------------------------------
COMMENT ON FUNCTION private.member_manager_role(UUID) IS
    'Authority for member-management RPCs: aal2 platform admins only.';
COMMENT ON FUNCTION public.begin_privileged_action(UUID, TEXT, UUID) IS
    'aal2 platform admin authorizes a service_role workflow (connect, disconnect, sync, report, invitation).';
COMMENT ON FUNCTION public.set_ad_account_sync(UUID, UUID[]) IS
    'aal2 platform admin selects which accounts of a connection are synced and audited.';
COMMENT ON FUNCTION public.get_tenant_members(UUID) IS
    'Tenant member directory for aal2 platform admins.';
COMMENT ON FUNCTION public.change_member_role(UUID, UUID, TEXT) IS
    'aal2 platform admin changes a member role; keeps one active owner.';
COMMENT ON FUNCTION public.deactivate_member(UUID, UUID) IS
    'aal2 platform admin deactivates a member and revokes their pending invitations.';
COMMENT ON FUNCTION public.revoke_invitation(UUID) IS
    'aal2 platform admin revokes a pending invitation.';
COMMENT ON FUNCTION public.accept_invitation(TEXT) IS
    'Retired (20261113120000): not executable by any API role. Client accounts are created by staff.';
