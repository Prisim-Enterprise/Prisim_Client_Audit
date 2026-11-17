// @vitest-environment node
import { type AdConnectionDependencies, createAdConnectionsHandler } from "@functions/ad-connections/handler.ts";
import { json, withHttp } from "@functions/_shared/http.ts";
import { signState, verifyState } from "@functions/_shared/oauth-state.ts";
import { createProvider } from "@functions/_shared/providers/config.ts";
import { ProviderError } from "@functions/_shared/providers/types.ts";
import { createSyncHandler, drainQueue, type SyncHandlerDependencies } from "@functions/sync-ad-data/handler.ts";
import { describe, expect, it, vi } from "vitest";

const ORIGIN = "https://portal.example.com";
const SECRET = "state-secret-that-is-long-enough-123456";
const USER = "e1000000-0000-4000-8000-000000000001";
const TENANT = "d1000000-0000-4000-8000-000000000001";
const ACTION = "a1000000-0000-4000-8000-000000000001";
const CONNECTION = "c1000000-0000-4000-8000-000000000001";

const fullEnv: Record<string, string> = {
  APP_URL: ORIGIN,
  OAUTH_STATE_SECRET: SECRET,
  META_APP_ID: "app",
  META_APP_SECRET: "secret",
  GOOGLE_OAUTH_CLIENT_ID: "client",
  GOOGLE_OAUTH_CLIENT_SECRET: "secret",
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev",
};

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/fn`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

function connectionDeps(overrides: Partial<AdConnectionDependencies> = {}, env = fullEnv) {
  const provider = {
    provider: "google" as const,
    authorizeUrl: vi.fn((state: string, challenge: string) => `https://accounts.google.com/auth?state=${state}&c=${challenge}`),
    exchangeCode: vi.fn(async () => ({ accessToken: "access", refreshToken: "refresh", expiresAt: null, scopes: ["https://www.googleapis.com/auth/adwords"] })),
    refresh: vi.fn(),
    identity: vi.fn(async () => ({ id: null, name: "Google Ads" })),
    listAccounts: vi.fn(async () => [{ external_account_id: "1234567890", account_name: "A", currency: "INR", timezone: null, status: "active" as const, metadata: {} }]),
    fetchCampaigns: vi.fn(),
    fetchMetrics: vi.fn(),
    revoke: vi.fn(async () => undefined),
  };
  const deps: AdConnectionDependencies = {
    env: (name) => env[name],
    authenticate: vi.fn(async () => USER),
    isPlatformAdmin: vi.fn(async () => true),
    beginAction: vi.fn(async () => ACTION),
    cleanupPendingConnections: vi.fn(async () => undefined),
    createConnection: vi.fn(async () => CONNECTION),
    getConnection: vi.fn(async () => ({ id: CONNECTION, tenant_id: TENANT, provider: "google" as const, status: "pending" })),
    storeTokens: vi.fn(async () => undefined),
    saveAccounts: vi.fn(async (_a, _c, accounts) => accounts.length),
    markConnectionError: vi.fn(async () => undefined),
    getTokens: vi.fn(async () => ({ access_token: "access", refresh_token: "refresh" })),
    deleteTokens: vi.fn(async () => undefined),
    clearSelection: vi.fn(async () => undefined),
    provider: () => provider,
    nowSeconds: () => 1_900_000_000,
    log: () => undefined,
    ...overrides,
  };
  const handler = withHttp(ORIGIN, (req, origin) => createAdConnectionsHandler(deps)(req, origin, req.headers.get("Authorization")?.slice(7) ?? null));
  return { deps, provider, handler };
}

const auth = { Authorization: "Bearer user-jwt" };

async function body(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

describe("ad-connections handler", () => {
  it("enforces CORS origin and authentication", async () => {
    const { handler } = connectionDeps();
    expect((await handler(request({ action: "providers" }, { Origin: "https://evil.example" }))).status).toBe(403);
    expect((await handler(request({ action: "providers" }))).status).toBe(401);
    const preflight = await handler(new Request(`${ORIGIN}/fn`, { method: "OPTIONS", headers: { Origin: ORIGIN } }));
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("reports missing credentials by name only", async () => {
    const { handler } = connectionDeps({}, { APP_URL: ORIGIN });
    const response = await handler(request({ action: "start", tenantId: TENANT, provider: "meta" }, auth));
    expect(response.status).toBe(503);
    const payload = await body(response);
    expect(payload.error).toBe("provider_not_configured");
    expect(payload.missing).toEqual(["META_APP_ID", "META_APP_SECRET", "OAUTH_STATE_SECRET"]);
  });

  it("starts OAuth with a signed, user-bound state", async () => {
    const { handler, deps } = connectionDeps();
    const response = await handler(request({ action: "start", tenantId: TENANT, provider: "google" }, auth));
    expect(response.status).toBe(200);
    const { authorizeUrl } = await body(response) as { authorizeUrl: string };
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    const payload = await verifyState(state, SECRET, 1_900_000_000);
    expect(payload).toMatchObject({ a: ACTION, c: CONNECTION, t: TENANT, u: USER, p: "google" });
    expect(deps.beginAction).toHaveBeenCalledWith("user-jwt", TENANT, "oauth.connect");
  });

  it("refuses to start when SQL denies the privileged action", async () => {
    const { handler, deps } = connectionDeps({ beginAction: vi.fn(async () => null) });
    expect((await handler(request({ action: "start", tenantId: TENANT, provider: "google" }, auth))).status).toBe(403);
    expect(deps.createConnection).not.toHaveBeenCalled();
  });

  async function validState(overrides: Record<string, unknown> = {}) {
    return signState({ v: 1, a: ACTION, c: CONNECTION, t: TENANT, p: "google", u: USER, n: "nonce-value-123456789", e: 1_900_000_600, ...overrides } as never, SECRET);
  }

  it("completes OAuth: stores tokens with the bound action and saves accounts", async () => {
    const { handler, deps } = connectionDeps();
    const response = await handler(request({ action: "complete", code: "auth-code", state: await validState() }, auth));
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ connectionId: CONNECTION, accountsDiscovered: 1 });
    expect(deps.storeTokens).toHaveBeenCalledWith(CONNECTION, expect.objectContaining({ accessToken: "access" }), ACTION);
    const text = JSON.stringify(await (await handler(request({ action: "complete", code: "auth-code", state: await validState() }, auth))).json());
    expect(text).not.toContain("access");
  });

  it("rejects states for another user, tenant mismatches and reused connections", async () => {
    const other = connectionDeps({ authenticate: vi.fn(async () => "e2000000-0000-4000-8000-000000000002") });
    expect((await other.handler(request({ action: "complete", code: "x", state: await validState() }, auth))).status).toBe(403);

    const mismatch = connectionDeps({ getConnection: vi.fn(async () => ({ id: CONNECTION, tenant_id: "d2000000-0000-4000-8000-000000000002", provider: "google" as const, status: "pending" })) });
    expect((await mismatch.handler(request({ action: "complete", code: "x", state: await validState() }, auth))).status).toBe(400);

    const used = connectionDeps({ getConnection: vi.fn(async () => ({ id: CONNECTION, tenant_id: TENANT, provider: "google" as const, status: "connected" })) });
    expect((await used.handler(request({ action: "complete", code: "x", state: await validState() }, auth))).status).toBe(409);
    expect(used.deps.storeTokens).not.toHaveBeenCalled();

    const expired = connectionDeps({ nowSeconds: () => 1_900_001_000 });
    expect((await expired.handler(request({ action: "complete", code: "x", state: await validState() }, auth))).status).toBe(400);
  });

  it("marks the connection failed when the provider rejects the code", async () => {
    const { handler, deps, provider } = connectionDeps();
    provider.exchangeCode.mockRejectedValueOnce(new ProviderError("provider_error", "Google Ads returned an error.", "google 400 invalid_grant"));
    const response = await handler(request({ action: "complete", code: "bad", state: await validState() }, auth));
    expect(response.status).toBe(502);
    expect(deps.markConnectionError).toHaveBeenCalledWith(CONNECTION);
    expect(JSON.stringify(await body(response))).not.toContain("invalid_grant");
  });

  it("runs the full staff OAuth flow: start, provider consent, callback, completion", async () => {
    const { handler, deps, provider } = connectionDeps();
    const started = await handler(request({ action: "start", tenantId: TENANT, provider: "google" }, auth));
    expect(started.status).toBe(200);
    const { authorizeUrl } = await body(started) as { authorizeUrl: string };
    const consent = new URL(authorizeUrl);
    const state = consent.searchParams.get("state")!;
    // PKCE challenge is sent to the provider; the verifier never leaves the server.
    expect(consent.searchParams.get("c")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Provider redirects to /oauth/callback; the SPA posts code + state back.
    const completed = await handler(request({ action: "complete", code: "auth-code", state }, auth));
    expect(completed.status).toBe(200);
    expect(await body(completed)).toMatchObject({ connectionId: CONNECTION, tenantId: TENANT, provider: "google", accountsDiscovered: 1 });
    expect(provider.exchangeCode).toHaveBeenCalledWith("auth-code", expect.any(String));
    const verifier = (provider.exchangeCode.mock.calls[0] as unknown[])[1] as string;
    expect(verifier).not.toBe(consent.searchParams.get("c"));
    expect(deps.storeTokens).toHaveBeenCalledWith(CONNECTION, expect.objectContaining({ accessToken: "access" }), ACTION);
    expect(deps.saveAccounts).toHaveBeenCalledWith(ACTION, CONNECTION, expect.any(Array), expect.anything(), expect.anything());
    expect(deps.isPlatformAdmin).toHaveBeenCalledTimes(2);
    // A tampered state is rejected before any provider call.
    const tampered = state.slice(0, -2) + (state.endsWith("A") ? "BB" : "AA");
    const before = provider.exchangeCode.mock.calls.length;
    expect((await handler(request({ action: "complete", code: "auth-code", state: tampered }, auth))).status).toBe(400);
    expect(provider.exchangeCode.mock.calls.length).toBe(before);
  });

  it("denies every action to users who are not aal2 PRISIM staff, before any database or provider call", async () => {
    const state = await validState();
    for (const payload of [
      { action: "providers" },
      { action: "start", tenantId: TENANT, provider: "google" },
      { action: "complete", code: "auth-code", state },
      { action: "disconnect", connectionId: CONNECTION },
    ]) {
      const { handler, deps, provider } = connectionDeps({ isPlatformAdmin: vi.fn(async () => false) });
      const response = await handler(request(payload, auth));
      expect(response.status).toBe(403);
      expect(await body(response)).toEqual({ error: "platform_admin_required" });
      expect(deps.beginAction).not.toHaveBeenCalled();
      expect(deps.createConnection).not.toHaveBeenCalled();
      expect(deps.getConnection).not.toHaveBeenCalled();
      expect(deps.storeTokens).not.toHaveBeenCalled();
      expect(deps.deleteTokens).not.toHaveBeenCalled();
      expect(provider.exchangeCode).not.toHaveBeenCalled();
      expect(provider.revoke).not.toHaveBeenCalled();
    }
  });

  it("checks authentication before staff status and staff status before reading the body", async () => {
    const anonymous = connectionDeps({ authenticate: vi.fn(async () => null) });
    expect((await anonymous.handler(request({ action: "providers" }, auth))).status).toBe(401);
    expect(anonymous.deps.isPlatformAdmin).not.toHaveBeenCalled();
    const client = connectionDeps({ isPlatformAdmin: vi.fn(async () => false) });
    const malformed = new Request(ORIGIN + "/fn", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, ...auth }, body: "{not json" });
    expect((await client.handler(malformed)).status).toBe(403);
  });

  describe("Meta system user connection (real Meta provider, fake Graph API)", () => {
    const TOKEN = "SYSTEM-USER-TOKEN-VALUE";
    const env = { ...fullEnv, META_APP_ID: "4242", META_APP_SECRET: "app-secret-value", META_LOGIN_CONFIG_ID: "227000000000001" };
    const account = (id: string) => ({ id: `act_${id}`, account_id: id, name: `Account ${id}`, currency: "INR", timezone_name: "Asia/Kolkata", account_status: 1 });

    function graph(debug: Record<string, unknown>) {
      const urls: string[] = [];
      const fetcher = async (url: string) => {
        urls.push(url);
        const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
        if (url.includes("/oauth/access_token")) return reply({ access_token: TOKEN });
        if (url.includes("/debug_token")) return reply({ data: debug });
        if (url.includes("/me/adaccounts")) return reply({ data: [account("111"), account("999")] });
        if (/\/me\?/.test(url)) return reply({ id: "555", client_business_id: "777" });
        const id = /\/act_(\d+)\?/.exec(url)?.[1];
        if (id === "111" || id === "999") return reply(account(id));
        return reply({ error: { code: 100 } }, 400);
      };
      return { fetcher, urls };
    }

    async function metaComplete(debug: Record<string, unknown>) {
      const { fetcher, urls } = graph(debug);
      const provider = createProvider("meta", (name) => env[name as keyof typeof env], fetcher);
      const { handler, deps } = connectionDeps({
        provider: () => provider,
        getConnection: vi.fn(async () => ({ id: CONNECTION, tenant_id: TENANT, provider: "meta" as const, status: "pending" })),
      }, env);
      const state = await signState({ v: 1, a: ACTION, c: CONNECTION, t: TENANT, p: "meta", u: USER, n: "nonce-value-123456789", e: 1_900_000_600 } as never, SECRET);
      const response = await handler(request({ action: "complete", code: "AUTH-CODE-VALUE", state }, auth));
      return { response, deps, urls, text: await response.text() };
    }

    const granted = { is_valid: true, app_id: "4242", expires_at: 0, scopes: ["ads_read"], granular_scopes: [{ scope: "ads_read", target_ids: ["111"] }] };

    it("stores the token in Vault and saves only the granted ad account; the browser never sees the token", async () => {
      const { response, deps, urls, text } = await metaComplete(granted);
      expect(response.status).toBe(200);
      expect(JSON.parse(text)).toEqual({ connectionId: CONNECTION, tenantId: TENANT, provider: "meta", accountsDiscovered: 1, warning: null });
      expect(text).not.toContain(TOKEN);
      expect(deps.storeTokens).toHaveBeenCalledWith(CONNECTION, { accessToken: TOKEN, refreshToken: null, expiresAt: null, scopes: ["ads_read"] }, ACTION);
      const saved = (deps.saveAccounts as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
      expect((saved[2] as Array<{ external_account_id: string }>).map((item) => item.external_account_id)).toEqual(["act_111"]);
      expect(saved[3]).toEqual({ id: "777", name: "Meta business 777" });
      expect(saved[4]).toEqual(["ads_read"]);
      // The ungranted account is never requested, so it cannot be discovered or stored.
      expect(urls.some((url) => url.includes("act_999") || url.includes("/me/adaccounts"))).toBe(false);
    });

    it("stores nothing when ads_read was not granted to an explicit ad account", async () => {
      const { response, deps, text } = await metaComplete({ ...granted, granular_scopes: [{ scope: "ads_read" }] });
      expect(response.status).toBe(502);
      expect(JSON.parse(text)).toEqual({ error: "provider_error", message: "No ad account was shared with PRISIM. Reconnect and select the ad account to share." });
      expect(text).not.toContain(TOKEN);
      expect(deps.storeTokens).not.toHaveBeenCalled();
      expect(deps.saveAccounts).not.toHaveBeenCalled();
      expect(deps.markConnectionError).toHaveBeenCalledWith(CONNECTION);
    });
  });

  it("disconnects with an oauth.disconnect action bound to the connection", async () => {
    const { handler, deps, provider } = connectionDeps();
    const response = await handler(request({ action: "disconnect", connectionId: CONNECTION }, auth));
    expect(response.status).toBe(200);
    expect(deps.beginAction).toHaveBeenCalledWith("user-jwt", TENANT, "oauth.disconnect", CONNECTION);
    expect(provider.revoke).toHaveBeenCalled();
    expect(deps.deleteTokens).toHaveBeenCalledWith(CONNECTION, ACTION);
  });
});

describe("sync-ad-data handler", () => {
  const CRON = "cron-secret-value-that-is-long-enough-1234";
  function syncDeps(overrides: Partial<SyncHandlerDependencies> = {}) {
    const deps: SyncHandlerDependencies = {
      cronSecret: CRON,
      authenticate: vi.fn(async () => USER),
      isPlatformAdmin: vi.fn(async () => true),
      connectionTenant: vi.fn(async () => TENANT),
      beginSyncAction: vi.fn(async () => ACTION),
      startJob: vi.fn(async () => ({ jobId: "job-1" })),
      enqueueScheduled: vi.fn(async () => 3),
      claim: vi.fn(async () => null),
      process: vi.fn(async () => ({ success: true, error: null })),
      background: vi.fn(),
      now: () => 0,
      ...overrides,
    };
    // Cron requests have no Origin header.
    const handler = withHttp(ORIGIN, (req, origin) => createSyncHandler(deps)(req, origin, req.headers.get("Authorization")?.slice(7) ?? null));
    return { deps, handler };
  }

  const cronRequest = (secret: string) =>
    new Request(`${ORIGIN}/fn`, { method: "POST", headers: { "x-prisim-cron-secret": secret }, body: JSON.stringify({ action: "run-scheduled" }) });

  it("requires the exact cron secret for scheduled runs", async () => {
    const { handler, deps } = syncDeps();
    expect((await handler(cronRequest("wrong"))).status).toBe(401);
    const response = await handler(cronRequest(CRON));
    expect(response.status).toBe(202);
    expect(deps.enqueueScheduled).toHaveBeenCalled();
    expect(deps.background).toHaveBeenCalled();
    const unset = syncDeps({ cronSecret: undefined });
    expect((await unset.handler(cronRequest(""))).status).toBe(401);
  });

  it("starts a manual sync only with a sync.start action", async () => {
    const { handler, deps } = syncDeps();
    expect((await handler(request({ action: "start", connectionId: CONNECTION }))).status).toBe(401);
    const response = await handler(request({ action: "start", connectionId: CONNECTION, jobType: "backfill" }, auth));
    expect(response.status).toBe(202);
    expect(deps.beginSyncAction).toHaveBeenCalledWith("user-jwt", TENANT, CONNECTION);
    expect(deps.startJob).toHaveBeenCalledWith(ACTION, CONNECTION, "backfill");

    const denied = syncDeps({ beginSyncAction: vi.fn(async () => null) });
    expect((await denied.handler(request({ action: "start", connectionId: CONNECTION }, auth))).status).toBe(403);
    const busy = syncDeps({ startJob: vi.fn(async () => ({ conflict: true as const })) });
    expect((await busy.handler(request({ action: "start", connectionId: CONNECTION }, auth))).status).toBe(409);
  });

  it("lets only aal2 PRISIM staff start a manual sync", async () => {
    const client = syncDeps({ isPlatformAdmin: vi.fn(async () => false) });
    const response = await client.handler(request({ action: "start", connectionId: CONNECTION }, auth));
    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({ error: "platform_admin_required" });
    expect(client.deps.connectionTenant).not.toHaveBeenCalled();
    expect(client.deps.beginSyncAction).not.toHaveBeenCalled();
    expect(client.deps.startJob).not.toHaveBeenCalled();
    expect(client.deps.background).not.toHaveBeenCalled();
  });

  it("keeps scheduled sync on the cron secret only (no user, no staff check)", async () => {
    const { handler, deps } = syncDeps({ isPlatformAdmin: vi.fn(async () => false) });
    const response = await handler(cronRequest(CRON));
    expect(response.status).toBe(202);
    expect(deps.enqueueScheduled).toHaveBeenCalled();
    expect(deps.isPlatformAdmin).not.toHaveBeenCalled();
    expect(deps.authenticate).not.toHaveBeenCalled();
    // A user JWT cannot trigger the scheduled path without the secret.
    const withJwt = new Request(ORIGIN + "/fn", { method: "POST", headers: { ...auth }, body: JSON.stringify({ action: "run-scheduled" }) });
    expect((await handler(withJwt)).status).toBe(401);
  });

  it("drains the queue within its time budget", async () => {
    let clock = 0;
    const jobs = ["a", "b", "c"];
    const { deps } = syncDeps({
      claim: vi.fn(async () => (jobs.length ? ({ job_id: jobs.shift() } as never) : null)),
      process: vi.fn(async () => {
        clock += 50_000;
        return { success: true, error: null };
      }),
      now: () => clock,
    });
    expect(await drainQueue(deps)).toBe(3);
    const manual = syncDeps({ claim: vi.fn(async () => ({ job_id: "x" }) as never) });
    expect(await drainQueue(manual.deps, "x")).toBe(1);
  });
});

describe("http helpers", () => {
  it("never caches responses", () => {
    expect(json(200, {}).headers.get("Cache-Control")).toBe("no-store");
  });
});
