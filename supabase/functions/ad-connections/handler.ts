// ad-connections: Meta / Google Ads OAuth for a tenant.
//
//   providers   -> which providers are configured (secret names only)
//   start       -> privileged oauth.connect action + pending connection,
//                  returns the provider consent URL with a signed state
//   complete    -> called by the SPA's /oauth/callback with code + state;
//                  exchanges the code server-side, stores tokens in Vault,
//                  discovers ad accounts
//   disconnect  -> oauth.disconnect action, provider revocation (best
//                  effort) and Vault purge
//
// Tokens never leave this function. Every user-initiated change goes through
// begin_privileged_action with the caller's own JWT, so SQL decides who may
// act and the audit trail names the real user.

import { HttpError, isUuid, json, readBody } from "../_shared/http.ts";
import { pkceChallenge, pkceVerifier, randomNonce, signState, verifyState } from "../_shared/oauth-state.ts";
import { type EnvReader, providerStatus } from "../_shared/providers/config.ts";
import { type AdProvider, type DiscoveredAccount, ProviderError, type TokenSet } from "../_shared/providers/types.ts";

export type ConnectionRow = { id: string; tenant_id: string; provider: "meta" | "google"; status: string };

export type AdConnectionDependencies = {
  env: EnvReader;
  authenticate(jwt: string): Promise<string | null>;
  beginAction(jwt: string, tenantId: string, action: "oauth.connect" | "oauth.disconnect", targetId?: string): Promise<string | null>;
  cleanupPendingConnections(tenantId: string): Promise<void>;
  createConnection(actionId: string, tenantId: string, provider: "meta" | "google"): Promise<string | null>;
  getConnection(connectionId: string): Promise<ConnectionRow | null>;
  storeTokens(connectionId: string, tokens: TokenSet, actionId: string): Promise<void>;
  saveAccounts(actionId: string, connectionId: string, accounts: DiscoveredAccount[], identity: { id: string | null; name: string | null }, scopes: string[] | null): Promise<number>;
  markConnectionError(connectionId: string): Promise<void>;
  getTokens(connectionId: string): Promise<{ access_token: string | null; refresh_token: string | null } | null>;
  deleteTokens(connectionId: string, actionId: string): Promise<void>;
  clearSelection(jwt: string, connectionId: string): Promise<void>;
  provider(name: "meta" | "google"): AdProvider;
  nowSeconds(): number;
  log(message: string): void;
};

const STATE_TTL_SECONDS = 10 * 60;

function provider(value: unknown): "meta" | "google" {
  if (value === "meta" || value === "google") return value;
  throw new HttpError(400, "invalid_request");
}

export function createAdConnectionsHandler(deps: AdConnectionDependencies) {
  return async (request: Request, origin: string, jwt: string | null): Promise<Response> => {
    if (!jwt) throw new HttpError(401, "not_authenticated");
    const body = await readBody(request);
    const userId = await deps.authenticate(jwt);
    if (!userId) throw new HttpError(401, "not_authenticated");
    const status = providerStatus(deps.env);

    switch (body.action) {
      case "providers":
        return json(200, { providers: status }, origin);

      case "start": {
        const name = provider(body.provider);
        if (!isUuid(body.tenantId)) throw new HttpError(400, "invalid_request");
        if (!status[name].configured) {
          throw new HttpError(503, "provider_not_configured", { provider: name, missing: status[name].missing });
        }
        const actionId = await deps.beginAction(jwt, body.tenantId, "oauth.connect");
        if (!actionId) throw new HttpError(403, "not_authorized");
        await deps.cleanupPendingConnections(body.tenantId).catch(() => undefined);
        const connectionId = await deps.createConnection(actionId, body.tenantId, name);
        if (!connectionId) throw new HttpError(409, "connection_not_created");

        const secret = deps.env("OAUTH_STATE_SECRET")!;
        const nonce = randomNonce();
        const state = await signState({
          v: 1,
          a: actionId,
          c: connectionId,
          t: body.tenantId,
          p: name,
          u: userId,
          n: nonce,
          e: deps.nowSeconds() + STATE_TTL_SECONDS,
        }, secret);
        const challenge = await pkceChallenge(await pkceVerifier(secret, nonce));
        return json(200, {
          connectionId,
          authorizeUrl: deps.provider(name).authorizeUrl(state, challenge),
        }, origin);
      }

      case "complete": {
        if (typeof body.code !== "string" || body.code.length === 0 || body.code.length > 2048 || typeof body.state !== "string") {
          throw new HttpError(400, "invalid_request");
        }
        const secret = deps.env("OAUTH_STATE_SECRET");
        if (!secret) throw new HttpError(503, "provider_not_configured");
        const state = await verifyState(body.state, secret, deps.nowSeconds());
        if (!state) throw new HttpError(400, "invalid_state");
        if (state.u !== userId) throw new HttpError(403, "state_user_mismatch");
        if (!status[state.p].configured) {
          throw new HttpError(503, "provider_not_configured", { provider: state.p, missing: status[state.p].missing });
        }

        const connection = await deps.getConnection(state.c);
        if (!connection || connection.tenant_id !== state.t || connection.provider !== state.p) {
          throw new HttpError(400, "invalid_state");
        }
        if (connection.status !== "pending") throw new HttpError(409, "connection_not_pending");

        const adProvider = deps.provider(state.p);
        let tokens: TokenSet;
        try {
          tokens = await adProvider.exchangeCode(body.code, await pkceVerifier(secret, state.n));
        } catch (error) {
          await deps.markConnectionError(connection.id).catch(() => undefined);
          if (error instanceof ProviderError) {
            deps.log(`token exchange failed: ${error.code} ${error.detail ?? ""}`);
            throw new HttpError(502, "provider_error", { message: error.message });
          }
          throw error;
        }
        await deps.storeTokens(connection.id, tokens, state.a);

        let discovered: DiscoveredAccount[] = [];
        let warning: string | null = null;
        let identity: { id: string | null; name: string | null } = { id: null, name: null };
        try {
          identity = await adProvider.identity(tokens.accessToken);
          discovered = await adProvider.listAccounts(tokens.accessToken);
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          deps.log(`account discovery failed: ${error.code} ${error.detail ?? ""}`);
          warning = error.message;
        }
        const saved = await deps.saveAccounts(state.a, connection.id, discovered, identity, tokens.scopes);
        return json(200, {
          connectionId: connection.id,
          tenantId: connection.tenant_id,
          provider: connection.provider,
          accountsDiscovered: saved,
          warning,
        }, origin);
      }

      case "disconnect": {
        if (!isUuid(body.connectionId)) throw new HttpError(400, "invalid_request");
        const connection = await deps.getConnection(body.connectionId);
        if (!connection) throw new HttpError(404, "connection_not_found");
        const actionId = await deps.beginAction(jwt, connection.tenant_id, "oauth.disconnect", connection.id);
        if (!actionId) throw new HttpError(403, "not_authorized");

        if (status[connection.provider].configured) {
          try {
            const tokens = await deps.getTokens(connection.id);
            if (tokens?.access_token) await deps.provider(connection.provider).revoke(tokens.access_token, tokens.refresh_token);
          } catch {
            deps.log("provider revocation failed; local credentials are still deleted");
          }
        }
        await deps.deleteTokens(connection.id, actionId);
        await deps.clearSelection(jwt, connection.id).catch(() => undefined);
        return json(200, { connectionId: connection.id, status: "revoked" }, origin);
      }

      default:
        throw new HttpError(400, "invalid_request");
    }
  };
}
