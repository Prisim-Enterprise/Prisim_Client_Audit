-- =====================================================
-- PRISIM CLIENT AUDIT PORTAL
-- MIGRATION 20261111100100 - SCHEDULED JOBS (pg_cron + pg_net)
-- =====================================================
--
-- STATUS: Not applied to hosted. Requires 20261111100000_audit_platform.sql.
--
-- Both extensions are available on the Supabase Free plan, but this migration
-- checks availability and degrades to a no-op instead of failing:
--   * without pg_cron, nothing is scheduled (run syncs manually)
--   * without pg_net or the two Vault secrets below, the hourly dispatcher
--     only queues jobs; they run on the next manual or function-driven sync
--
-- Required Vault secrets for the hourly sync dispatcher (set by the project
-- owner in Dashboard -> Project Settings -> Vault, never in git):
--   prisim_functions_base_url  https://<project-ref>.supabase.co/functions/v1
--   prisim_cron_secret         same value as the CRON_SECRET Edge Function secret
-- =====================================================

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
        CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
    ELSE
        RAISE NOTICE 'pg_cron is not available; scheduled jobs are not created.';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
        CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
    ELSE
        RAISE NOTICE 'pg_net is not available; the sync dispatcher will only queue jobs.';
    END IF;
END;
$$;

-- Queue due syncs, then wake the sync-ad-data Edge Function so it drains the
-- queue. Returns the pg_net request id, or NULL when only queuing happened.
CREATE FUNCTION private.dispatch_scheduled_sync()
RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_base TEXT;
    v_secret TEXT;
    v_request BIGINT;
BEGIN
    PERFORM public.enqueue_scheduled_sync_jobs();

    IF NOT EXISTS (SELECT 1 FROM public.sync_jobs j WHERE j.status = 'pending') THEN
        RETURN NULL;
    END IF;
    IF to_regnamespace('net') IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT s.decrypted_secret INTO v_base FROM vault.decrypted_secrets s WHERE s.name = 'prisim_functions_base_url';
    SELECT s.decrypted_secret INTO v_secret FROM vault.decrypted_secrets s WHERE s.name = 'prisim_cron_secret';
    IF v_base IS NULL OR v_secret IS NULL OR v_base !~ '^https://' THEN
        RETURN NULL;
    END IF;

    EXECUTE 'SELECT net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 5000)'
    INTO v_request
    USING rtrim(v_base, '/') || '/sync-ad-data',
          jsonb_build_object('action', 'run-scheduled'),
          jsonb_build_object('Content-Type', 'application/json', 'x-prisim-cron-secret', v_secret);
    RETURN v_request;
END;
$$;
REVOKE ALL ON FUNCTION private.dispatch_scheduled_sync() FROM PUBLIC;

DO $$
BEGIN
    IF to_regnamespace('cron') IS NULL THEN
        RETURN;
    END IF;
    PERFORM cron.schedule('prisim-sync-dispatch', '7 * * * *', 'SELECT private.dispatch_scheduled_sync()');
    PERFORM cron.schedule('prisim-expire-invitations', '20 2 * * *', 'SELECT public.expire_stale_invitations()');
    PERFORM cron.schedule('prisim-prune-operational-data', '40 2 * * *', 'SELECT private.prune_operational_data()');
END;
$$;

-- Scheduled jobs completed.
