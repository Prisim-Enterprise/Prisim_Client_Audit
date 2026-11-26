// @vitest-environment node
// Sync 2.0 (per-account results, diagnostics) and the provider queries behind
// the audit engine's data-quality and diagnostic checks.
import { runAudit } from "@functions/_shared/audit/engine.ts";
import { toSaveAuditPayload } from "@functions/_shared/audit/payload.ts";
import { createGoogleProvider } from "@functions/_shared/providers/google.ts";
import { createMetaProvider } from "@functions/_shared/providers/meta.ts";
import { type AdProvider, checkedNumber, ProviderError } from "@functions/_shared/providers/types.ts";
import { evidenceLines, toReportData } from "@functions/_shared/report/data.ts";
import { buildAuditReportPdf } from "@functions/_shared/report/pdf.ts";
import { type ClaimedJob, diagnosticsWindow, processSyncJob, type SyncDependencies } from "@functions/_shared/sync.ts";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";

type Call = { url: string; init?: RequestInit };

function fakeFetch(routes: Array<[RegExp | ((call: Call) => boolean), (call: Call) => { status?: number; body: unknown }]>) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    const route = routes.find(([match]) => (typeof match === "function" ? match(call) : match.test(url)));
    if (!route) return new Response(JSON.stringify({ error: { message: "no route" } }), { status: 404 });
    const { status = 200, body } = route[1](call);
    return new Response(JSON.stringify(body), { status });
  };
  return { fetcher, calls };
}

const query = (call: Call) => (call.init?.body ? (JSON.parse(String(call.init.body)).query as string) : "");
const account = { id: "acct", external_account_id: "9574280792", currency: "INR", timezone: "Asia/Calcutta", metadata: { login_customer_id: "9574280792" } };

describe("Google provider (v24 fields)", () => {
  const config = { clientId: "id", clientSecret: "secret", redirectUri: "https://x.example/oauth/callback", apiVersion: "v24" };

  it("reads campaign status reasons, schedule and shared budget details", async () => {
    const { fetcher, calls } = fakeFetch([[/googleAds:search/, () => ({ body: { results: [{
      campaign: { id: "24546116371", name: "App Campaign", status: "ENABLED", servingStatus: "SERVING", primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["CAMPAIGN_PENDING"], advertisingChannelType: "MULTI_CHANNEL", advertisingChannelSubType: "APP_CAMPAIGN", biddingStrategyType: "TARGET_CPA", startDateTime: "2026-11-20 00:00:00" },
      campaignBudget: { id: "77", amountMicros: "700000000", period: "DAILY", explicitlyShared: false, referenceCount: "1" },
    }] } })]]);
    const [campaign] = await createGoogleProvider(config, fetcher).fetchCampaigns("token", account);
    const gaql = query(calls[0]);
    for (const field of ["campaign.primary_status_reasons", "campaign.start_date_time", "campaign.end_date_time", "campaign_budget.explicitly_shared", "campaign_budget.reference_count", "campaign.advertising_channel_sub_type"]) {
      expect(gaql).toContain(field);
    }
    expect(gaql).not.toMatch(/campaign\.start_date[^_]/); // removed in v24
    expect(campaign).toMatchObject({ external_id: "24546116371", status: "ENABLED", daily_budget: 700, channel_type: "MULTI_CHANNEL" });
    expect(campaign.details).toMatchObject({ channel_sub_type: "APP_CAMPAIGN", primary_status: "NOT_ELIGIBLE", primary_status_reasons: ["CAMPAIGN_PENDING"], start: "2026-11-20 00:00:00", end: null, budget_id: "77", budget_shared: false, budget_reference_count: 1 });
  });

  it("marks non-numeric metric values instead of silently storing zero", async () => {
    const { fetcher } = fakeFetch([[/googleAds:search/, () => ({ body: { results: [{ campaign: { id: "1" }, segments: { date: "2026-11-01" }, metrics: { impressions: "abc", clicks: "3", costMicros: "1000000" } }] } })]]);
    const [row] = await createGoogleProvider(config, fetcher).fetchMetrics("token", account, "2026-11-01", "2026-11-01");
    expect(row).toMatchObject({ impressions: 0, clicks: 3, spend: 1, invalid_fields: ["impressions"] });
    const invalid: string[] = [];
    expect(checkedNumber(undefined, "x", invalid)).toBe(0);
    expect(checkedNumber("", "x", invalid)).toBe(0);
    expect(invalid).toEqual([]);
  });

  it("captures diagnostics; a refused section becomes 'unavailable' without failing the others", async () => {
    const { fetcher, calls } = fakeFetch([
      [(call) => query(call).includes("FROM keyword_view"), () => ({ status: 400, body: { error: { code: 400, status: "INVALID_ARGUMENT" } } })],
      [(call) => query(call).includes("FROM conversion_action"), () => ({ body: { results: [{ conversionAction: { id: "5", name: "Install", status: "ENABLED", category: "DOWNLOAD", primaryForGoal: true, includeInConversionsMetric: true, countingType: "ONE_PER_CLICK", valueSettings: { defaultValue: 0, alwaysUseDefaultValue: false } } }] } })],
      [(call) => query(call).includes("FROM search_term_view"), () => ({ body: { results: [] } })],
      [/googleAds:search/, () => ({ body: { results: [] } })],
    ]);
    const diagnostics = await createGoogleProvider(config, fetcher).fetchDiagnostics!("token", account, "2026-10-26", "2026-11-24");
    expect(Object.keys(diagnostics.sections).sort()).toEqual(["ads", "conversion_actions", "keywords", "search_impression_share", "search_terms"]);
    expect(diagnostics.sections.keywords).toMatchObject({ status: "unavailable" });
    expect(diagnostics.sections.conversion_actions).toMatchObject({ status: "ok", rows: [{ id: "5", status: "ENABLED", primary_for_goal: true, counting_type: "ONE_PER_CLICK" }] });
    const share = calls.map(query).find((text) => text.includes("search_impression_share"))!;
    expect(share).toContain("segments.date BETWEEN '2026-10-26' AND '2026-11-24'");
    expect(share).not.toMatch(/SELECT[^]*segments\.date[^]*FROM/); // ratio metrics are read for the whole window
    expect(calls.every((call) => !(call.init?.headers as Record<string, string>)["developer-token"])).toBe(true);
    await expect(createGoogleProvider(config, fetcher).fetchDiagnostics!("t", account, "bad", "2026-11-24")).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("Meta provider (campaign details and diagnostics)", () => {
  const config = { appId: "app", appSecret: "secret", redirectUri: "https://x.example/oauth/callback", apiVersion: "v26.0" };
  const meta = { id: "acct", external_account_id: "act_1", currency: "INR", timezone: null, metadata: {} };

  it("records the budget level, schedule and configured status", async () => {
    const { fetcher, calls } = fakeFetch([[/campaigns/, () => ({ body: { data: [
      { id: "1", name: "CBO", objective: "OUTCOME_SALES", effective_status: "ACTIVE", status: "ACTIVE", daily_budget: "50000", start_time: "2026-10-01T00:00:00+0530" },
      { id: "2", name: "ABO", objective: "OUTCOME_LEADS", effective_status: "PAUSED", status: "PAUSED" },
    ] } })]]);
    const [cbo, abo] = await createMetaProvider(config, fetcher).fetchCampaigns("token", meta);
    expect(new URL(calls[0].url).searchParams.get("fields")).toContain("lifetime_budget");
    expect(cbo).toMatchObject({ daily_budget: 500, details: { budget_level: "campaign", start: "2026-10-01T00:00:00+0530", serving_status: "ACTIVE" } });
    expect(abo).toMatchObject({ daily_budget: null, details: { budget_level: "ad_set" } });
  });

  it("flags reach as unavailable when Meta refuses it", async () => {
    const { fetcher } = fakeFetch([
      [(call) => call.url.includes("insights") && (new URL(call.url).searchParams.get("fields") ?? "").includes("reach"), () => ({ status: 400, body: { error: { code: 100, message: "reach" } } })],
      [/insights/, () => ({ body: { data: [{ campaign_id: "1", date_start: "2026-11-01", impressions: "10", clicks: "1", spend: "2" }] } })],
    ]);
    const [row] = await createMetaProvider(config, fetcher).fetchMetrics("token", meta, "2026-11-01", "2026-11-01");
    expect(row.invalid_fields).toEqual(["reach_unavailable"]);
  });

  it("reads ad set learning status with the optimization goal, ad status and pixels", async () => {
    const { fetcher } = fakeFetch([
      [/adsets/, () => ({ body: { data: [{ id: "s1", campaign_id: "1", effective_status: "ACTIVE", optimization_goal: "OFFSITE_CONVERSIONS", daily_budget: "20000", learning_stage_info: { status: "FAIL", conversions: 12 } }] } })],
      [/\/ads\?/, () => ({ body: { data: [{ campaign_id: "1", effective_status: "DISAPPROVED" }] } })],
      [/adspixels/, () => ({ status: 403, body: { error: { code: 200, message: "no access" } } })],
    ]);
    const diagnostics = await createMetaProvider(config, fetcher).fetchDiagnostics!("token", meta, "2026-10-26", "2026-11-24");
    expect(diagnostics.sections.ad_sets).toMatchObject({ status: "ok", rows: [{ learning_status: "FAIL", optimization_goal: "OFFSITE_CONVERSIONS", daily_budget: 200, learning_conversions: 12 }] });
    expect(diagnostics.sections.ads).toMatchObject({ status: "ok", rows: [{ effective_status: "DISAPPROVED" }] });
    expect(diagnostics.sections.pixels).toMatchObject({ status: "unavailable" });
  });
});

describe("sync job per-account results", () => {
  const today = new Date("2026-11-25T11:35:00Z");
  const job = (): ClaimedJob => ({
    job_id: "job",
    tenant_id: "t",
    connection_id: "conn",
    provider: "google",
    job_type: "manual_sync",
    last_success_at: null,
    accounts: [
      { id: "a1", external_account_id: "111", currency: "INR", timezone: null, metadata: {} },
      { id: "a2", external_account_id: "222", currency: "INR", timezone: null, metadata: {} },
    ],
  });

  function deps(provider: Partial<AdProvider>, extra: Partial<SyncDependencies> = {}) {
    const fake: SyncDependencies = {
      provider: () => ({
        provider: "google",
        authorizeUrl: () => "",
        exchangeCode: vi.fn(),
        refresh: vi.fn(),
        identity: vi.fn(),
        listAccounts: vi.fn(),
        fetchCampaigns: vi.fn(async () => []),
        fetchMetrics: vi.fn(async () => []),
        revoke: vi.fn(),
        ...provider,
      }),
      getTokens: vi.fn(async () => ({ access_token: "a", refresh_token: "r", expires_at: "2027-01-01T00:00:00Z" })),
      storeRefreshedTokens: vi.fn(async () => undefined),
      ingest: vi.fn(async (_job, _account, campaigns: unknown[], metrics: unknown[]) => ({ campaigns: campaigns.length, metrics: metrics.length })),
      complete: vi.fn(async () => undefined),
      setConnectionStatus: vi.fn(async () => undefined),
      now: () => today,
      ...extra,
    };
    return fake;
  }

  it("records which accounts succeeded or failed, for which window, with invalid and unavailable values", async () => {
    const fake = deps({
      fetchMetrics: vi.fn(async (_token, synced) => {
        if (synced.id === "a2") throw new ProviderError("permission_denied", "Google Ads denied access to this account.");
        return [
          { external_campaign_id: "1", date: "2026-11-01", impressions: 0, reach: 0, clicks: 1, spend: 1, conversions: 0, conversion_value: 0, invalid_fields: ["impressions"] },
          { external_campaign_id: "1", date: "2026-11-02", impressions: 5, reach: 0, clicks: 1, spend: 1, conversions: 0, conversion_value: 0, invalid_fields: ["reach_unavailable"] },
        ];
      }),
    });
    const result = await processSyncJob(job(), fake);
    expect(result.success).toBe(true);
    const ingested = (fake.ingest as ReturnType<typeof vi.fn>).mock.calls[0][3] as Array<Record<string, unknown>>;
    expect(ingested.every((row) => !("invalid_fields" in row))).toBe(true);
    const stats = (fake.complete as ReturnType<typeof vi.fn>).mock.calls[0][3] as { account_results: unknown[] };
    expect(stats.account_results).toEqual([
      expect.objectContaining({ ad_account_id: "a1", status: "succeeded", since: "2026-08-27", until: "2026-11-24", metrics: 2, invalid_values: 1, unavailable_fields: ["reach"], diagnostics: "skipped" }),
      expect.objectContaining({ ad_account_id: "a2", status: "failed", error: "Google Ads denied access to this account." }),
    ]);
  });

  it("stores diagnostics for the last 30 days and never fails the sync when they fail", async () => {
    const storeDiagnostics = vi.fn(async () => undefined);
    let first = true;
    const fake = deps({
      fetchDiagnostics: vi.fn(async (_token, _account, since, until) => {
        if (!first) throw new ProviderError("provider_error", "boom");
        first = false;
        return { provider: "google" as const, window: { since, until }, captured_at: "x", sections: {} };
      }),
    }, { storeDiagnostics });
    const result = await processSyncJob(job(), fake);
    expect(result.success).toBe(true);
    expect(storeDiagnostics).toHaveBeenCalledWith("job", "a1", expect.objectContaining({ window: { since: "2026-10-26", until: "2026-11-24" } }));
    const stats = (fake.complete as ReturnType<typeof vi.fn>).mock.calls[0][3] as { account_results: Array<{ diagnostics: string }> };
    expect(stats.account_results.map((item) => item.diagnostics)).toEqual(["stored", "failed"]);
    expect(diagnosticsWindow({ since: "2026-11-20", until: "2026-11-24" })).toEqual({ since: "2026-11-20", until: "2026-11-24" });
  });
});

describe("report output for engine 2.0", () => {
  const result = runAudit({
    tenantName: "Cleanwell Solutions",
    periodStart: "2026-10-26",
    periodEnd: "2026-11-24",
    accounts: [{ id: "acc", provider: "google", name: "Cleanwell Solutions", currency: "INR" }],
    campaigns: [{ id: "c", adAccountId: "acc", provider: "google", name: "App Campaign", objective: "MULTI_CHANNEL", status: "ENABLED", channelType: "MULTI_CHANNEL", bidStrategy: "TARGET_CPA", dailyBudget: 700, impressions: 0, reach: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0, activeDays: 0 }],
    daily: [],
    syncRuns: [{ adAccountId: "acc", connectionId: "x", jobType: "manual_sync", status: "succeeded", completedAt: "2026-11-25T11:35:23Z", since: "2026-08-27", until: "2026-11-24", invalidValues: 0, unavailableFields: [], error: null, legacy: false }],
    generatedAt: "2026-11-26T00:00:00Z",
  });
  const payload = toSaveAuditPayload(result, { title: "Audit", periodStart: "2026-10-26", periodEnd: "2026-11-24", adAccountIds: ["acc"] });

  it("stores a NULL score with the status and evidence the UI and PDF need", () => {
    expect(payload.run.overall_score).toBeNull();
    expect(payload.run.kpis.score_status).toBe("unscored");
    expect(payload.run.category_scores).toEqual({});
    expect(JSON.stringify(payload).length).toBeLessThan(200_000);
  });

  it("renders an unscored audit with confidence, evidence and limitations", async () => {
    const data = toReportData({
      tenantName: "Cleanwell Solutions",
      run: { id: "r", title: "Audit", period_start: "2026-10-26", period_end: "2026-11-24", status: "draft", engine_version: payload.run.engine_version, overall_score: null, platform_scores: {}, category_scores: {}, kpis: payload.run.kpis as never, summary: payload.run.summary },
      findings: payload.findings.map((finding, index) => ({ ...finding, severity: finding.severity as "medium", reviewer_note: null, status: "open", sort_order: index })),
      campaigns: [],
    });
    expect(data.scoreStatus).toBe("unscored");
    expect(data.dataConfidence?.level).toBe("high");
    expect(data.lastSuccessfulSync).toBe("2026-11-25T11:35:23Z");
    expect(data.findings.find((finding) => finding.title.includes("No advertising delivery"))?.basis).toBe("verified");
    expect(data.limitations?.length).toBeGreaterThan(0);
    const doc = await PDFDocument.load(await buildAuditReportPdf(data));
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(4);
  });

  it("formats legacy 1.0 evidence and 2.0 evidence", () => {
    expect(evidenceLines({ spend: 10, clicks: 5 })).toEqual(["Evidence: spend: 10; clicks: 5"]);
    const lines = evidenceLines(payload.findings[0].evidence);
    expect(lines.some((line) => line.startsWith("Observed:"))).toBe(true);
    expect(lines.some((line) => line.includes("Period 2026-10-26 to 2026-11-24"))).toBe(true);
  });
});
