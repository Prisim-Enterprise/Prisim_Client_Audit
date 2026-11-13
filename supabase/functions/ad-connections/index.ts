import { bearerToken, withHttp } from "../_shared/http.ts";
import { createProvider } from "../_shared/providers/config.ts";
import { readServerConfig, serviceClient, userClient } from "../_shared/supabase.ts";
import { type AdConnectionDependencies, createAdConnectionsHandler } from "./handler.ts";

function dependencies(): AdConnectionDependencies {
  const config = readServerConfig(true);
  const service = serviceClient(config);
  const env = (name: string) => Deno.env.get(name);

  return {
    env,
    async authenticate(jwt) {
      const { data, error } = await service.auth.getUser(jwt);
      return error || !data.user ? null : data.user.id;
    },
    async beginAction(jwt, tenantId, action, targetId) {
      const { data, error } = await userClient(config, jwt).rpc("begin_privileged_action", {
        p_tenant_id: tenantId,
        p_action: action,
        p_target_id: targetId ?? null,
      });
      const row = Array.isArray(data) ? data[0] : null;
      return !error && typeof row?.action_id === "string" ? row.action_id : null;
    },
    async cleanupPendingConnections(tenantId) {
      // Abandoned consents leave pending rows without credentials.
      await service
        .from("oauth_connections")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("status", "pending")
        .lt("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString());
    },
    async createConnection(actionId, tenantId, provider) {
      const { data, error } = await service.rpc("create_oauth_connection", {
        p_action_id: actionId,
        p_tenant_id: tenantId,
        p_provider: provider,
      });
      return !error && typeof data === "string" ? data : null;
    },
    async getConnection(connectionId) {
      const { data, error } = await service
        .from("oauth_connections")
        .select("id, tenant_id, provider, status")
        .eq("id", connectionId)
        .maybeSingle();
      return error || !data ? null : data;
    },
    async storeTokens(connectionId, tokens, actionId) {
      const { error } = await service.rpc("store_oauth_tokens", {
        p_connection_id: connectionId,
        p_access_token: tokens.accessToken,
        p_refresh_token: tokens.refreshToken,
        p_expires_at: tokens.expiresAt,
        p_action_id: actionId,
      });
      if (error) throw new Error("token_store_failed");
    },
    async saveAccounts(actionId, connectionId, accounts, identity, scopes) {
      const { data, error } = await service.rpc("upsert_discovered_ad_accounts", {
        p_action_id: actionId,
        p_connection_id: connectionId,
        p_accounts: accounts,
        p_provider_account_id: identity.id,
        p_account_name: identity.name,
        p_scopes: scopes,
      });
      if (error) throw new Error("account_save_failed");
      return typeof data === "number" ? data : 0;
    },
    async markConnectionError(connectionId) {
      await service.rpc("set_connection_status", { p_connection_id: connectionId, p_status: "error" });
    },
    async getTokens(connectionId) {
      const { data, error } = await service.rpc("get_oauth_tokens", { p_connection_id: connectionId });
      const row = Array.isArray(data) ? data[0] : null;
      return error || !row ? null : { access_token: row.access_token, refresh_token: row.refresh_token };
    },
    async deleteTokens(connectionId, actionId) {
      const { error } = await service.rpc("delete_oauth_tokens", { p_connection_id: connectionId, p_action_id: actionId });
      if (error) throw new Error("token_delete_failed");
    },
    async clearSelection(jwt, connectionId) {
      await userClient(config, jwt).rpc("set_ad_account_sync", { p_connection_id: connectionId, p_ad_account_ids: [] });
    },
    provider: (name) => createProvider(name, env),
    nowSeconds: () => Math.floor(Date.now() / 1000),
    log: (message) => console.warn(`[ad-connections] ${message}`),
  };
}

if (import.meta.main) {
  let handler: ReturnType<typeof createAdConnectionsHandler> | undefined;
  Deno.serve(withHttp(Deno.env.get("APP_URL"), (request, origin) => {
    handler ??= createAdConnectionsHandler(dependencies());
    return handler(request, origin, bearerToken(request));
  }, console.warn));
}
