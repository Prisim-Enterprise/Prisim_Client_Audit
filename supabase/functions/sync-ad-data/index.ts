import { bearerToken, withHttp } from "../_shared/http.ts";
import { createProvider } from "../_shared/providers/config.ts";
import { readServerConfig, serviceClient, userClient } from "../_shared/supabase.ts";
import { type ClaimedJob, processSyncJob } from "../_shared/sync.ts";
import { createSyncHandler, type SyncHandlerDependencies } from "./handler.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

function dependencies(): SyncHandlerDependencies {
  const config = readServerConfig(true);
  const service = serviceClient(config);
  const env = (name: string) => Deno.env.get(name);

  const syncDeps = {
    provider: (name: "meta" | "google") => createProvider(name, env),
    async getTokens(connectionId: string) {
      const { data, error } = await service.rpc("get_oauth_tokens", { p_connection_id: connectionId });
      const row = Array.isArray(data) ? data[0] : null;
      return error || !row ? null : row;
    },
    async storeRefreshedTokens(connectionId: string, accessToken: string, refreshToken: string | null, expiresAt: string | null) {
      const { error } = await service.rpc("store_oauth_tokens", {
        p_connection_id: connectionId,
        p_access_token: accessToken,
        p_refresh_token: refreshToken,
        p_expires_at: expiresAt,
        p_action_id: null,
      });
      if (error) throw new Error("token_refresh_store_failed");
    },
    async ingest(jobId: string, adAccountId: string, campaigns: unknown[], metrics: unknown[]) {
      const { data, error } = await service.rpc("ingest_ad_account_data", {
        p_job_id: jobId,
        p_ad_account_id: adAccountId,
        p_campaigns: campaigns,
        p_metrics: metrics,
      });
      if (error) throw new Error("ingest_failed");
      return data as { campaigns: number; metrics: number };
    },
    async complete(jobId: string, success: boolean, message: string | null, stats: Record<string, unknown>) {
      const { error } = await service.rpc("complete_sync_job", {
        p_job_id: jobId,
        p_success: success,
        p_error: message,
        p_stats: stats,
      });
      if (error) throw new Error("complete_failed");
    },
    async setConnectionStatus(connectionId: string, status: "expired" | "error") {
      await service.rpc("set_connection_status", { p_connection_id: connectionId, p_status: status });
    },
    now: () => new Date(),
  };

  return {
    cronSecret: Deno.env.get("CRON_SECRET"),
    async authenticate(jwt) {
      const { data, error } = await service.auth.getUser(jwt);
      return error || !data.user ? null : data.user.id;
    },
    async connectionTenant(connectionId) {
      const { data } = await service.from("oauth_connections").select("tenant_id").eq("id", connectionId).maybeSingle();
      return data?.tenant_id ?? null;
    },
    async beginSyncAction(jwt, tenantId, connectionId) {
      const { data, error } = await userClient(config, jwt).rpc("begin_privileged_action", {
        p_tenant_id: tenantId,
        p_action: "sync.start",
        p_target_id: connectionId,
      });
      const row = Array.isArray(data) ? data[0] : null;
      return !error && typeof row?.action_id === "string" ? row.action_id : null;
    },
    async startJob(actionId, connectionId, jobType) {
      const { data, error } = await service.rpc("start_sync_job", {
        p_action_id: actionId,
        p_connection_id: connectionId,
        p_job_type: jobType,
      });
      if (error?.code === "55006") return { conflict: true };
      return !error && typeof data === "string" ? { jobId: data } : null;
    },
    async enqueueScheduled() {
      const { data, error } = await service.rpc("enqueue_scheduled_sync_jobs");
      if (error) throw new Error("enqueue_failed");
      return typeof data === "number" ? data : 0;
    },
    async claim(jobId) {
      const { data, error } = await service.rpc("claim_sync_job", { p_job_id: jobId });
      if (error) throw new Error("claim_failed");
      return (data as ClaimedJob | null) ?? null;
    },
    process: (job) => processSyncJob(job, syncDeps),
    background(task) {
      const guarded = task.catch(() => console.warn("[sync-ad-data] background task failed"));
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime) EdgeRuntime.waitUntil(guarded);
    },
    now: () => Date.now(),
  };
}

if (import.meta.main) {
  let handler: ReturnType<typeof createSyncHandler> | undefined;
  Deno.serve(withHttp(Deno.env.get("APP_URL"), (request, origin) => {
    handler ??= createSyncHandler(dependencies());
    return handler(request, origin, bearerToken(request));
  }, console.warn));
}
