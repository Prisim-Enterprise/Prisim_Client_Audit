// @vitest-environment node
import { type AdConnectionDependencies, createAdConnectionsHandler } from "@functions/ad-connections/handler.ts";
import { json, withHttp } from "@functions/_shared/http.ts";
import { signState, verifyState } from "@functions/_shared/oauth-state.ts";
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
