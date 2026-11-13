// @vitest-environment node
import { createGoogleProvider, microsToUnits } from "@functions/_shared/providers/google.ts";
import { createMetaProvider, metaConversions } from "@functions/_shared/providers/meta.ts";
import { providerStatus } from "@functions/_shared/providers/config.ts";
import { type AdProvider, ProviderError } from "@functions/_shared/providers/types.ts";
import { type ClaimedJob, processSyncJob, type SyncDependencies, syncWindow } from "@functions/_shared/sync.ts";
import { describe, expect, it, vi } from "vitest";

type Call = { url: string; init?: RequestInit };

function fakeFetch(routes: Array<[RegExp, (call: Call) => { status?: number; body: unknown }]>) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const route = routes.find(([pattern]) => pattern.test(url));
    if (!route) return new Response(JSON.stringify({ error: { message: "no route" } }), { status: 404 });
    const { status = 200, body } = route[1]({ url, init });
    return new Response(JSON.stringify(body), { status });
  };
  return { fetcher, calls };
}

const account = { id: "acct", external_account_id: "act_123", currency: "INR", timezone: "Asia/Kolkata", metadata: {} };

describe("Meta provider", () => {
  const config = { appId: "app", appSecret: "secret", redirectUri: "https://portal.example/oauth/callback", apiVersion: "v26.0" };

  it("builds a consent URL with read-only scopes", () => {
    const url = new URL(createMetaProvider(config).authorizeUrl("state-1", "unused"));
    expect(url.origin).toBe("https://www.facebook.com");
    expect(url.searchParams.get("scope")).toBe("ads_read,business_management");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
  });

  it("de-duplicates overlapping conversion action types", () => {
    expect(metaConversions(
      [
        { action_type: "omni_purchase", value: "5" },
        { action_type: "purchase", value: "5" },
        { action_type: "offsite_conversion.fb_pixel_purchase", value: "5" },
        { action_type: "lead", value: "3" },
        { action_type: "link_click", value: "100" },
      ],
      [{ action_type: "omni_purchase", value: "250.5" }, { action_type: "purchase", value: "250.5" }],
    )).toEqual({ conversions: 8, conversionValue: 250.5 });
  });

  it("exchanges a code for a long-lived token and requires ads_read", async () => {
    const { fetcher, calls } = fakeFetch([
      [/oauth\/access_token.*fb_exchange_token/, () => ({ body: { access_token: "long", expires_in: 5_184_000 } })],
      [/oauth\/access_token/, () => ({ body: { access_token: "short", expires_in: 3600 } })],
      [/me\/permissions/, () => ({ body: { data: [{ permission: "ads_read", status: "granted" }] } })],
    ]);
    const tokens = await createMetaProvider(config, fetcher).exchangeCode("code", "verifier");
    expect(tokens.accessToken).toBe("long");
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.scopes).toEqual(["ads_read"]);
    const permissionCall = calls.find((call) => call.url.includes("/me/permissions"));
    expect(new URL(permissionCall!.url).searchParams.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("maps daily insights and follows paging", async () => {
    const { fetcher } = fakeFetch([
      [/after=2/, () => ({ body: { data: [{ campaign_id: "c2", date_start: "2026-10-02", impressions: "50", clicks: "2", spend: "1.5" }] } })],
      [/insights/, () => ({
        body: {
          data: [{ campaign_id: "c1", date_start: "2026-10-01", impressions: "1000", reach: "800", clicks: "20", spend: "12.34", actions: [{ action_type: "lead", value: "2" }] }],
          paging: { next: "https://graph.facebook.com/v26.0/act_123/insights?after=2" },
        },
      })],
    ]);
    const rows = await createMetaProvider(config, fetcher).fetchMetrics("token", account, "2026-10-01", "2026-10-02");
    expect(rows).toEqual([
      { external_campaign_id: "c1", date: "2026-10-01", impressions: 1000, reach: 800, clicks: 20, spend: 12.34, conversions: 2, conversion_value: 0 },
      { external_campaign_id: "c2", date: "2026-10-02", impressions: 50, reach: 0, clicks: 2, spend: 1.5, conversions: 0, conversion_value: 0 },
    ]);
  });

  it("converts budgets from minor units and maps auth errors", async () => {
    const { fetcher } = fakeFetch([[/campaigns/, () => ({ body: { data: [{ id: "1", name: "A", daily_budget: "150000", effective_status: "ACTIVE" }] } })]]);
    const campaigns = await createMetaProvider(config, fetcher).fetchCampaigns("token", account);
    expect(campaigns[0].daily_budget).toBe(1500);
    const failing = fakeFetch([[/./, () => ({ status: 400, body: { error: { code: 190, message: "expired" } } })]]);
    await expect(createMetaProvider(config, failing.fetcher).listAccounts("token")).rejects.toMatchObject({ code: "auth_expired" });
  });
});

describe("Google Ads provider", () => {
  const config = { clientId: "id", clientSecret: "secret", developerToken: "dev", redirectUri: "https://portal.example/oauth/callback", apiVersion: "v24" };

  it("uses PKCE and offline access", () => {
    const url = new URL(createGoogleProvider(config).authorizeUrl("st", "challenge"));
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/adwords");
  });

  it("maps search rows, micros and login-customer-id", async () => {
    const { fetcher, calls } = fakeFetch([[/googleAds:search/, () => ({
      body: { results: [{ campaign: { id: "77" }, segments: { date: "2026-10-01" }, metrics: { impressions: "100", clicks: "9", costMicros: "2500000", conversions: 1.5, conversionsValue: 30 } }] },
    })]]);
    const rows = await createGoogleProvider(config, fetcher).fetchMetrics("token", { ...account, external_account_id: "1234567890", metadata: { login_customer_id: "9999999999" } }, "2026-10-01", "2026-10-01");
    expect(rows[0]).toEqual({ external_campaign_id: "77", date: "2026-10-01", impressions: 100, reach: 0, clicks: 9, spend: 2.5, conversions: 1.5, conversion_value: 30 });
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["developer-token"]).toBe("dev");
    expect(headers["login-customer-id"]).toBe("9999999999");
    expect(calls[0].url).toBe("https://googleads.googleapis.com/v24/customers/1234567890/googleAds:search");
    expect(microsToUnits("1000000")).toBe(1);
  });

  it("discovers client accounts under a manager account", async () => {
    const { fetcher } = fakeFetch([
      [/listAccessibleCustomers/, () => ({ body: { resourceNames: ["customers/1111111111"] } })],
      [/googleAds:search/, ({ init }) => {
        const query = JSON.parse(String(init?.body)).query as string;
        return query.includes("customer_client")
          ? { body: { results: [{ customerClient: { id: "2222222222", descriptiveName: "Client", currencyCode: "INR", timeZone: "Asia/Kolkata", status: "ENABLED" } }] } }
          : { body: { results: [{ customer: { id: "1111111111", manager: true, status: "ENABLED" } }] } };
      }],
    ]);
    const accounts = await createGoogleProvider(config, fetcher).listAccounts("token");
    expect(accounts).toEqual([{ external_account_id: "2222222222", account_name: "Client", currency: "INR", timezone: "Asia/Kolkata", status: "active", metadata: { login_customer_id: "1111111111" } }]);
  });

  it("reports an unapproved developer token clearly", async () => {
    const { fetcher } = fakeFetch([[/./, () => ({ status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED", details: [{ errors: [{ errorCode: { authorizationError: "DEVELOPER_TOKEN_NOT_APPROVED" } }] }] } } })]]);
    await expect(createGoogleProvider(config, fetcher).fetchCampaigns("t", { ...account, external_account_id: "1234567890" }))
      .rejects.toMatchObject({ code: "permission_denied", message: expect.stringMatching(/developer token/i) });
  });
});

describe("provider configuration", () => {
  it("lists missing secret names without values", () => {
    const status = providerStatus((name) => ({ APP_URL: "https://x.example", OAUTH_STATE_SECRET: "s".repeat(40), META_APP_ID: "1" } as Record<string, string>)[name]);
    expect(status.meta).toMatchObject({ configured: false, missing: ["META_APP_SECRET"] });
    expect(status.google.missing).toEqual(["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_ADS_DEVELOPER_TOKEN"]);
    expect(providerStatus(() => undefined).meta.missing).toContain("OAUTH_STATE_SECRET");
  });
});

describe("sync orchestration", () => {
  const today = new Date("2026-11-11T08:00:00Z");

  it("chooses windows per job type", () => {
    expect(syncWindow({ job_type: "backfill", last_success_at: null }, today)).toEqual({ since: "2026-08-13", until: "2026-11-10" });
    expect(syncWindow({ job_type: "manual_sync", last_success_at: "2026-11-10T00:00:00Z" }, today)).toEqual({ since: "2026-10-12", until: "2026-11-10" });
    expect(syncWindow({ job_type: "daily_sync", last_success_at: "2026-11-10T01:00:00Z" }, today)).toEqual({ since: "2026-11-04", until: "2026-11-10" });
    expect(syncWindow({ job_type: "daily_sync", last_success_at: "2026-10-20T01:00:00Z" }, today)).toEqual({ since: "2026-10-17", until: "2026-11-10" });
  });

  function job(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
    return {
      job_id: "job",
      tenant_id: "tenant",
      connection_id: "conn",
      provider: "google",
      job_type: "daily_sync",
      last_success_at: "2026-11-10T00:00:00Z",
      accounts: [account, { ...account, id: "acct2", external_account_id: "act_456" }],
      ...overrides,
    };
  }

  type Tokens = { access_token: string | null; refresh_token: string | null; expires_at: string | null } | null;
  function deps(provider: Partial<AdProvider>, tokens: Tokens = { access_token: "a", refresh_token: "r", expires_at: "2026-11-11T08:01:00Z" }) {
    const fake: SyncDependencies = {
      provider: () => ({
        provider: "google",
        authorizeUrl: () => "",
        exchangeCode: vi.fn(),
        refresh: vi.fn(async () => ({ accessToken: "fresh", refreshToken: null, expiresAt: "2026-11-11T09:00:00Z", scopes: null })),
        identity: vi.fn(),
        listAccounts: vi.fn(),
        fetchCampaigns: vi.fn(async () => [{ external_id: "1", name: "c", objective: null, status: null, daily_budget: null, bid_strategy: null, channel_type: null }]),
        fetchMetrics: vi.fn(async () => Array.from({ length: 7001 }, (_, index) => ({ external_campaign_id: "1", date: `d${index}`, impressions: 1, reach: 0, clicks: 0, spend: 0, conversions: 0, conversion_value: 0 }))),
        revoke: vi.fn(),
        ...provider,
      }),
      getTokens: vi.fn(async () => tokens),
      storeRefreshedTokens: vi.fn(async () => undefined),
      ingest: vi.fn(async (_job, _account, campaigns: unknown[], metrics: unknown[]) => ({ campaigns: campaigns.length, metrics: metrics.length })),
      complete: vi.fn(async () => undefined),
      setConnectionStatus: vi.fn(async () => undefined),
      now: () => today,
    };
    return fake;
  }

  it("refreshes expiring tokens, batches metrics and completes", async () => {
    const fake = deps({});
    const result = await processSyncJob(job(), fake);
    expect(result).toEqual({ success: true, error: null });
    expect(fake.storeRefreshedTokens).toHaveBeenCalledWith("conn", "fresh", null, "2026-11-11T09:00:00Z");
    // 7001 metrics -> 2 batches per account, campaigns only in the first
    expect(fake.ingest).toHaveBeenCalledTimes(4);
    expect(fake.complete).toHaveBeenCalledWith("job", true, null, expect.objectContaining({ accounts: 2, metrics: 14002 }));
  });

  it("marks the connection expired when credentials are rejected", async () => {
    const fake = deps({
      fetchCampaigns: vi.fn(async () => {
        throw new ProviderError("auth_expired", "expired");
      }),
    }, { access_token: "a", refresh_token: "r", expires_at: "2027-01-01T00:00:00Z" });
    const result = await processSyncJob(job(), fake);
    expect(result.success).toBe(false);
    expect(fake.setConnectionStatus).toHaveBeenCalledWith("conn", "expired");
    expect(fake.complete).toHaveBeenCalledWith("job", false, "expired", expect.any(Object));
  });

  it("succeeds partially when only some accounts fail", async () => {
    let first = true;
    const fake = deps({
      fetchMetrics: vi.fn(async () => {
        if (first) {
          first = false;
          throw new ProviderError("permission_denied", "denied");
        }
        return [];
      }),
    }, { access_token: "a", refresh_token: null, expires_at: null });
    const result = await processSyncJob(job(), fake);
    expect(result.success).toBe(true);
    expect(result.error).toContain("act_123: denied");
  });

  it("fails cleanly without stored credentials", async () => {
    const fake = deps({}, null);
    const result = await processSyncJob(job(), fake);
    expect(result.success).toBe(false);
    expect(fake.setConnectionStatus).toHaveBeenCalledWith("conn", "expired");
  });
});
