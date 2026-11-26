// @vitest-environment node
// Remediation of the final accuracy review: zero-delivery proof (D1-D5),
// independent Google/Meta frameworks, severity caps and no cross-platform score.
import { FRAMEWORKS, GOOGLE_THRESHOLDS, META_THRESHOLDS, runAudit } from "@functions/_shared/audit/engine.ts";
import { classifyGoogle } from "@functions/_shared/audit/google.ts";
import { buildAuditInput, toSyncRuns } from "@functions/_shared/audit/input.ts";
import { classifyMeta } from "@functions/_shared/audit/meta.ts";
import { toSaveAuditPayload } from "@functions/_shared/audit/payload.ts";
import type { AuditAccount, AuditCampaign, AuditInput, SyncRunRecord } from "@functions/_shared/audit/types.ts";
import { addDays } from "@functions/_shared/format.ts";
import { fetchAllRows, TruncatedResultError } from "@functions/_shared/paging.ts";
import { createGoogleProvider } from "@functions/_shared/providers/google.ts";
import { createMetaProvider } from "@functions/_shared/providers/meta.ts";
import { type AdProvider, MAX_METRIC_ROWS, ProviderError } from "@functions/_shared/providers/types.ts";
import { toReportData } from "@functions/_shared/report/data.ts";
import { buildAuditReportPdf } from "@functions/_shared/report/pdf.ts";
import { PDFDocument } from "pdf-lib";
import { type ClaimedJob, processSyncJob, reconcile, type SyncDependencies } from "@functions/_shared/sync.ts";
import { describe, expect, it, vi } from "vitest";

type Call = { url: string; init?: RequestInit };
const START = "2026-10-26";
const END = "2026-11-24";

function fakeFetch(handler: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const { status = 200, body } = handler({ url, init });
    return new Response(JSON.stringify(body), { status });
  };
  return { fetcher, calls };
}
const gaql = (call: Call) => (call.init?.body ? (JSON.parse(String(call.init.body)).query as string) : "");
const googleConfig = { clientId: "id", clientSecret: "secret", redirectUri: "https://x.example/oauth/callback", apiVersion: "v24" };
const metaConfig = { appId: "app", appSecret: "secret", redirectUri: "https://x.example/oauth/callback", apiVersion: "v26.0" };
const syncAccount = { id: "acct", external_account_id: "9574280792", currency: "INR", timezone: null, metadata: {} };

// ---------------------------------------------------------------------------
// D1 / D2: pagination completeness
// ---------------------------------------------------------------------------

describe("pagination completeness (D1, D2)", () => {
  it("Google: a remaining page token makes metrics incomplete instead of truncated", async () => {
    const page = Array.from({ length: 10_000 }, () => ({ campaign: { id: "1" }, segments: { date: "2026-11-01" }, metrics: { impressions: "1" } }));
    const { fetcher, calls } = fakeFetch(() => ({ body: { results: page, nextPageToken: "more" } }));
    await expect(createGoogleProvider(googleConfig, fetcher).fetchMetrics("t", syncAccount, START, END)).rejects.toMatchObject({ code: "incomplete" });
    expect(calls.length).toBe(MAX_METRIC_ROWS / 10_000);
  });

  it("Google: the last page (no token) is complete; removed campaigns are not filtered from metrics (D3)", async () => {
    const { fetcher, calls } = fakeFetch(() => ({ body: { results: [{ campaign: { id: "5" }, segments: { date: "2026-11-01" }, metrics: { impressions: "3", costMicros: "1000000" } }] } }));
    const rows = await createGoogleProvider(googleConfig, fetcher).fetchMetrics("t", syncAccount, START, END);
    expect(rows).toHaveLength(1);
    expect(gaql(calls[0])).not.toContain("REMOVED");
  });

  it("Google: removed campaigns are read by id without a status filter (D3)", async () => {
    const { fetcher, calls } = fakeFetch(() => ({ body: { results: [{ campaign: { id: "5", name: "Old", status: "REMOVED", advertisingChannelType: "SEARCH" } }] } }));
    const [campaign] = await createGoogleProvider(googleConfig, fetcher).fetchCampaignsById!("t", syncAccount, ["5", "x", "5"]);
    expect(gaql(calls[0])).toMatch(/WHERE campaign\.id IN \(5\)$/);
    expect(campaign).toMatchObject({ external_id: "5", status: "REMOVED" });
  });

  it("Google: account totals come from an unsegmented customer query", async () => {
    const { fetcher, calls } = fakeFetch(() => ({ body: { results: [{ metrics: { impressions: "0", costMicros: "0" } }] } }));
    await expect(createGoogleProvider(googleConfig, fetcher).fetchAccountTotals!("t", syncAccount, START, END)).resolves.toEqual({ impressions: 0, spend: 0 });
    expect(gaql(calls[0])).toBe(`SELECT metrics.impressions, metrics.cost_micros FROM customer WHERE segments.date BETWEEN '${START}' AND '${END}'`);
  });

  it("Meta: a remaining paging.next makes the result incomplete", async () => {
    const { fetcher } = fakeFetch(() => ({ body: { data: Array.from({ length: 10 }, () => ({ impressions: "1", spend: "1" })), paging: { next: "https://graph.facebook.com/v26.0/next" } } }));
    await expect(createMetaProvider(metaConfig, fetcher).fetchAccountTotals!("t", { ...syncAccount, external_account_id: "act_1" }, START, END)).rejects.toMatchObject({ code: "incomplete" });
  });

  it("Meta: insights store link clicks and per-objective results separately", async () => {
    const { fetcher, calls } = fakeFetch(() => ({ body: { data: [{ campaign_id: "1", date_start: "2026-11-01", impressions: "100", clicks: "9", inline_link_clicks: "4", spend: "2", actions: [{ action_type: "lead", value: "2" }, { action_type: "omni_purchase", value: "1" }, { action_type: "omni_complete_registration", value: "3" }] }] } }));
    const [row] = await createMetaProvider(metaConfig, fetcher).fetchMetrics("t", { ...syncAccount, external_account_id: "act_1" }, START, END);
    expect(new URL(calls[0].url).searchParams.get("fields")).toContain("inline_link_clicks");
    expect(row.clicks).toBe(9); // all clicks (legacy column)
    expect(row.platform_metrics).toMatchObject({ link_clicks: 4, leads: 2, purchases: 1, registrations: 3 });
  });

  it("database paging throws instead of returning a truncated result", async () => {
    const page = Array.from({ length: 10 }, (_, index) => index);
    const query = () => ({ range: async () => ({ data: page, error: null }) });
    await expect(fetchAllRows(query, 10, 30)).rejects.toBeInstanceOf(TruncatedResultError);
    const short = () => ({ range: async (from: number) => ({ data: from === 0 ? page : page.slice(0, 3), error: null }) });
    await expect(fetchAllRows(short, 10, 30)).resolves.toHaveLength(13);
  });
});

// ---------------------------------------------------------------------------
// Sync outcomes: partial failures, unknown campaigns, persisted rows, reconciliation
// ---------------------------------------------------------------------------

describe("sync outcomes", () => {
  const today = new Date("2026-11-25T11:35:00Z");
  const job = (provider: "google" | "meta" = "google"): ClaimedJob => ({
    job_id: "job", tenant_id: "t", connection_id: "conn", provider, job_type: "manual_sync", last_success_at: null,
    accounts: [{ id: "a1", external_account_id: "111", currency: "INR", timezone: null, metadata: {} }, { id: "a2", external_account_id: "222", currency: "INR", timezone: null, metadata: {} }],
  });
  const metric = (campaign: string, date: string, spend = 1) => ({ external_campaign_id: campaign, date, impressions: 10, reach: 0, clicks: 1, spend, conversions: 0, conversion_value: 0 });
  function deps(provider: Partial<AdProvider>, ingest?: SyncDependencies["ingest"]) {
    const fake: SyncDependencies = {
      provider: () => ({
        provider: "google", authorizeUrl: () => "", exchangeCode: vi.fn(), refresh: vi.fn(), identity: vi.fn(), listAccounts: vi.fn(), revoke: vi.fn(),
        fetchCampaigns: vi.fn(async () => [{ external_id: "1", name: "c", objective: null, status: "ENABLED", daily_budget: null, bid_strategy: null, channel_type: null }]),
        fetchMetrics: vi.fn(async () => [metric("1", "2026-11-01")]),
        fetchAccountTotals: vi.fn(async () => ({ impressions: 10, spend: 1 })),
        ...provider,
      }),
      getTokens: vi.fn(async () => ({ access_token: "a", refresh_token: "r", expires_at: "2027-01-01T00:00:00Z" })),
      storeRefreshedTokens: vi.fn(async () => undefined),
      ingest: ingest ?? vi.fn(async (_job, _account, _campaigns: unknown[], metrics: unknown[]) => ({ campaigns: _campaigns.length, metrics: metrics.length })),
      complete: vi.fn(async () => undefined),
      setConnectionStatus: vi.fn(async () => undefined),
      now: () => today,
    };
    return fake;
  }
  const results = (fake: SyncDependencies) => ((fake.complete as ReturnType<typeof vi.fn>).mock.calls[0][3] as { account_results: Array<Record<string, unknown>> }).account_results;

  it("an incomplete query fails only that account and records pagination", async () => {
    const fake = deps({
      fetchMetrics: vi.fn(async (_t, account) => {
        if (account.id === "a1") throw new ProviderError("incomplete", "Google Ads returned more than 200000 rows; the result was not read completely.");
        return [metric("1", "2026-11-01")];
      }),
    });
    const outcome = await processSyncJob(job(), fake);
    expect(outcome.success).toBe(true); // partial
    expect(results(fake)).toEqual([
      expect.objectContaining({ ad_account_id: "a1", status: "failed", pagination: "incomplete", reconciliation: "unverified" }),
      expect.objectContaining({ ad_account_id: "a2", status: "succeeded", pagination: "complete", fetched_rows: 1, persisted_rows: 1, reconciliation: "matched", zero_days_verified: true }),
    ]);
  });

  it("metrics of campaigns no longer listed are resolved by id or kept as placeholders", async () => {
    const fetchCampaignsById = vi.fn(async () => [{ external_id: "2", name: "Removed", objective: null, status: "REMOVED", daily_budget: null, bid_strategy: null, channel_type: null }]);
    const ingest = vi.fn(async (_job: string, _account: string, campaigns: unknown[], metrics: unknown[]) => ({ campaigns: campaigns.length, metrics: metrics.length }));
    const fake = deps({ fetchMetrics: vi.fn(async () => [metric("1", "2026-11-01"), metric("2", "2026-11-01"), metric("3", "2026-11-02")]), fetchCampaignsById, fetchAccountTotals: vi.fn(async () => ({ impressions: 30, spend: 3 })) }, ingest);
    await processSyncJob({ ...job(), accounts: [job().accounts[0]] }, fake);
    expect(fetchCampaignsById).toHaveBeenCalledWith("a", expect.anything(), ["2", "3"]);
    const campaigns = ingest.mock.calls[0][2] as Array<Record<string, unknown>>;
    expect(campaigns.map((item) => item.external_id)).toEqual(["1", "2", "3"]);
    expect(campaigns[2]).toMatchObject({ external_id: "3", placeholder: true, status: "UNKNOWN" });
    expect(results(fake)[0]).toMatchObject({ status: "succeeded", unresolved_campaigns: 1, fetched_rows: 3, persisted_rows: 3 });
  });

  it("fewer persisted than fetched rows fails the account", async () => {
    const fake = deps({}, vi.fn(async () => ({ campaigns: 1, metrics: 0 })));
    await processSyncJob({ ...job(), accounts: [job().accounts[0]] }, fake);
    expect(results(fake)[0]).toMatchObject({ status: "failed", fetched_rows: 1, persisted_rows: 0, error: "Only 0 of 1 metric rows were stored." });
  });

  it("reconciliation: Google zero totals prove zero delivery, Meta zero totals do not (D4)", () => {
    expect(reconcile("google", { impressions: 0, spend: 0 }, { impressions: 0, spend: 0 })).toBe("matched");
    expect(reconcile("meta", { impressions: 0, spend: 0 }, { impressions: 0, spend: 0 })).toBe("unverified");
    expect(reconcile("meta", { impressions: 1000, spend: 50 }, { impressions: 1000, spend: 50.2 })).toBe("matched");
    expect(reconcile("meta", { impressions: 1500, spend: 80 }, { impressions: 1000, spend: 50 })).toBe("mismatch");
    expect(reconcile("google", null, { impressions: 0, spend: 0 })).toBe("unverified");
  });

  it("only complete, fully stored, reconciled runs that the sync marked zero-verified verify zero days", () => {
    const accounts: AuditAccount[] = [{ id: "a1", provider: "google", name: "G", currency: "INR", connectionId: "conn" }];
    const job = (result: Record<string, unknown>) => ({ id: "j", connection_id: "conn", job_type: "daily_sync", status: "completed", completed_at: "2026-11-25T00:00:00Z", error_message: null, stats: { account_results: [{ ad_account_id: "a1", status: "succeeded", since: START, until: END, ...result }] } });
    const verified = (result: Record<string, unknown>) => toSyncRuns([job(result)], accounts)[0].zeroDaysVerified;
    const proof = { pagination: "complete", reconciliation: "matched", fetched_rows: 5, persisted_rows: 5, zero_days_verified: true };
    expect(verified(proof)).toBe(true);
    expect(verified({ ...proof, zero_days_verified: false })).toBe(false); // e.g. a Meta window
    expect(verified({ ...proof, reconciliation: "unverified" })).toBe(false);
    expect(verified({ ...proof, persisted_rows: 4 })).toBe(false);
    expect(verified({ ...proof, pagination: "incomplete" })).toBe(false);
    expect(verified({})).toBe(false); // engine 2.0 results (no proof recorded)
  });

  it("Meta windows are never zero-verified, even when the window totals reconcile", async () => {
    // Rows for 1 day; the account total equals them, so totals reconcile - but a
    // window total cannot say on which day delivery happened, so empty days stay unknown.
    const fake = deps({ fetchAccountTotals: vi.fn(async () => ({ impressions: 10, spend: 1 })) });
    await processSyncJob({ ...job("meta"), accounts: [job().accounts[0]] }, fake);
    expect(results(fake)[0]).toMatchObject({ status: "succeeded", reconciliation: "matched", zero_days_verified: false });
    // Same rows on Google: Google documents that all-zero date rows are omitted.
    const google = deps({});
    await processSyncJob({ ...job("google"), accounts: [job().accounts[0]] }, google);
    expect(results(google)[0]).toMatchObject({ reconciliation: "matched", zero_days_verified: true });
  });
});

// ---------------------------------------------------------------------------
// Engine: unverified days, platform independence, caps, cross-platform removal
// ---------------------------------------------------------------------------

const META = "a0000000-0000-4000-8000-000000000001";
const GOOGLE = "a0000000-0000-4000-8000-000000000002";

function run(adAccountId: string, overrides: Partial<SyncRunRecord> = {}): SyncRunRecord {
  return { adAccountId, connectionId: "c", jobType: "manual_sync", status: "succeeded", completedAt: "2026-11-25T11:00:00Z", since: "2026-08-27", until: END, invalidValues: 0, unavailableFields: [], error: null, legacy: false, zeroDaysVerified: true, reconciliation: "matched", ...overrides };
}

function campaign(overrides: Partial<AuditCampaign> & { id: string; adAccountId: string; provider: "meta" | "google" }): AuditCampaign {
  return {
    name: overrides.id, objective: null, status: overrides.provider === "meta" ? "ACTIVE" : "ENABLED", channelType: null, bidStrategy: null, dailyBudget: null,
    impressions: 0, reach: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0, activeDays: 0, externalId: overrides.id,
    details: { start: "2026-01-01", capturedAt: "2026-11-25T11:00:00Z" },
    ...overrides,
  };
}

function engineInput(overrides: Partial<AuditInput>): AuditInput {
  return { tenantName: "T", periodStart: START, periodEnd: END, accounts: [], campaigns: [], daily: [], generatedAt: "2026-11-26T09:00:00Z", ...overrides };
}

/** A campaign delivering every day (per-day values), with matching account daily rows. */
function delivering(account: AuditAccount, specs: Array<Partial<AuditCampaign> & { id: string; perDay: { impressions: number; clicks: number; spend: number; conversions: number; conversionValue?: number }; platformPerDay?: Record<string, number> }>) {
  const campaigns: AuditCampaign[] = [];
  const daily = new Map<string, { date: string; adAccountId: string; impressions: number; reach: number; clicks: number; spend: number; conversions: number; conversionValue: number }>();
  for (const spec of specs) {
    const { perDay, platformPerDay, ...rest } = spec;
    const days = 30;
    campaigns.push(campaign({
      provider: account.provider, adAccountId: account.id,
      impressions: perDay.impressions * days, clicks: perDay.clicks * days, spend: perDay.spend * days, conversions: perDay.conversions * days, conversionValue: (perDay.conversionValue ?? 0) * days, activeDays: days,
      reach: account.provider === "meta" ? perDay.impressions * days * 0.8 : 0,
      platformMetrics: platformPerDay ? Object.fromEntries(Object.entries(platformPerDay).map(([key, value]) => [key, value * days])) : undefined,
      ...rest,
    }));
    for (let index = 0; index < days; index += 1) {
      const date = addDays(START, index);
      const row = daily.get(date) ?? { date, adAccountId: account.id, impressions: 0, reach: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0 };
      row.impressions += perDay.impressions;
      row.reach += account.provider === "meta" ? perDay.impressions * 0.8 : 0;
      row.clicks += perDay.clicks;
      row.spend += perDay.spend;
      row.conversions += perDay.conversions;
      row.conversionValue += perDay.conversionValue ?? 0;
      daily.set(date, row);
    }
  }
  return { campaigns, daily: [...daily.values()] };
}

const metaAccount: AuditAccount = { id: META, provider: "meta", name: "Meta", currency: "INR" };
const googleAccount: AuditAccount = { id: GOOGLE, provider: "google", name: "Google", currency: "INR" };

describe("unverified zero delivery (D4)", () => {
  it("Meta: retrieved days without rows stay unknown, even with reconciled totals", () => {
    const idle = campaign({ id: "m1", adAccountId: META, provider: "meta", objective: "OUTCOME_LEADS" });
    // The record a Meta sync writes: complete, stored, reconciled - but not zero-verified.
    const metaRun = toSyncRuns([{
      id: "j", connection_id: "c", job_type: "manual_sync", status: "completed", completed_at: "2026-11-25T11:00:00Z", error_message: null,
      stats: { account_results: [{ ad_account_id: META, status: "succeeded", since: "2026-08-27", until: END, pagination: "complete", reconciliation: "matched", fetched_rows: 0, persisted_rows: 0, zero_days_verified: false }] },
    }], [{ ...metaAccount, connectionId: "c" }]);
    const unproven = runAudit(engineInput({ accounts: [metaAccount], campaigns: [idle], syncRuns: metaRun }));
    expect(unproven.kpis.accounts[0].coverage).toMatchObject({ retrievedDays: 30, zeroDeliveryDays: 0, unverifiedDays: 30, coverageRatio: 0 });
    const finding = unproven.findings.find((item) => item.ruleId === "data_quality.zero_delivery_unverified");
    expect(finding?.description).toContain("Meta does not document");
    expect(unproven.findings.map((item) => item.ruleId)).not.toContain("structure.no_account_delivery");
    expect(unproven.overallScore).toBeNull();
    // A Google record with the documented zero-row rule proves the same days.
    const idleGoogle = campaign({ id: "g1", adAccountId: GOOGLE, provider: "google", channelType: "SEARCH" });
    const proven = runAudit(engineInput({ accounts: [googleAccount], campaigns: [idleGoogle], syncRuns: [run(GOOGLE)] }));
    expect(proven.kpis.accounts[0].coverage).toMatchObject({ zeroDeliveryDays: 30, unverifiedDays: 0 });
    expect(proven.findings.map((item) => item.ruleId)).toContain("structure.no_account_delivery");
  });

  it("a mismatch between account totals and rows is a data problem", () => {
    const { campaigns, daily } = delivering(googleAccount, [{ id: "g1", channelType: "SEARCH", perDay: { impressions: 1000, clicks: 50, spend: 500, conversions: 2 } }]);
    const result = runAudit(engineInput({ accounts: [googleAccount], campaigns, daily, syncRuns: [run(GOOGLE, { reconciliation: "mismatch", zeroDaysVerified: false })] }));
    expect(result.findings.map((finding) => finding.ruleId)).toContain("data_quality.rows_not_reconciled");
    expect(result.scoreStatus).not.toBe("scored");
  });
});

describe("independent platform frameworks", () => {
  it("each platform has its own rules, thresholds and weights", () => {
    const google = new Set(FRAMEWORKS.google.rules.map((rule) => rule.id));
    const meta = new Set(FRAMEWORKS.meta.rules.map((rule) => rule.id));
    for (const id of ["engagement.quality_score", "budget.lost_impression_share", "efficiency.search_terms", "efficiency.pmax_search_terms", "engagement.asset_group_strength", "structure.manual_bidding", "engagement.low_ctr"]) {
      expect(google.has(id)).toBe(true);
      expect(meta.has(id)).toBe(false);
    }
    for (const id of ["engagement.high_frequency", "engagement.low_link_ctr", "engagement.high_cpm", "structure.learning_limited", "structure.optimization_mismatch", "engagement.placement_cost", "engagement.audience_cost", "engagement.creative_underperformance", "trend.creative_fatigue"]) {
      expect(meta.has(id)).toBe(true);
      expect(google.has(id)).toBe(false);
    }
    expect(FRAMEWORKS.google.scoring.weights).not.toEqual(FRAMEWORKS.meta.scoring.weights);
    expect(GOOGLE_THRESHOLDS).not.toHaveProperty("frequencyHigh");
    expect(META_THRESHOLDS).not.toHaveProperty("lowQualityScore");
    expect(META_THRESHOLDS.minLinkClicksForZeroResults).toBe(100);
  });

  it("Meta campaigns are classified by objective and judged on their own result", () => {
    const meta = (objective: string) => classifyMeta(campaign({ id: "x", adAccountId: META, provider: "meta", objective }));
    expect(meta("OUTCOME_SALES")).toMatchObject({ goal: "sales", resultMetric: "purchases" });
    expect(meta("OUTCOME_LEADS")).toMatchObject({ goal: "leads", resultMetric: "leads" });
    expect(meta("OUTCOME_APP_PROMOTION")).toMatchObject({ goal: "app", resultMetric: "app_installs" });
    expect(meta("OUTCOME_TRAFFIC")).toMatchObject({ goal: "traffic", resultMetric: "link_clicks" });
    expect(meta("OUTCOME_ENGAGEMENT")).toMatchObject({ goal: "engagement", resultMetric: null });
    expect(meta("OUTCOME_AWARENESS")).toMatchObject({ goal: "awareness", resultMetric: null });
    expect(meta("SOMETHING_NEW")).toMatchObject({ goal: "unknown", uncertain: true });
  });

  it("Google campaign types are classified separately", () => {
    const google = (overrides: Partial<AuditCampaign>) => classifyGoogle(campaign({ id: "x", adAccountId: GOOGLE, provider: "google", ...overrides }));
    expect(google({ channelType: "SEARCH", bidStrategy: "TARGET_CPA" })).toMatchObject({ kind: "search", goal: "conversions" });
    expect(google({ channelType: "SHOPPING" })).toMatchObject({ kind: "shopping", goal: "sales" });
    expect(google({ channelType: "PERFORMANCE_MAX" })).toMatchObject({ kind: "pmax", goal: "conversions" });
    expect(google({ channelType: "DISPLAY", bidStrategy: "TARGET_CPM" })).toMatchObject({ kind: "display", goal: "awareness", resultMetric: null });
    expect(google({ channelType: "VIDEO", bidStrategy: "TARGET_CPV" })).toMatchObject({ kind: "video", goal: "awareness" });
    expect(google({ channelType: "DEMAND_GEN", bidStrategy: "MAXIMIZE_CONVERSIONS" })).toMatchObject({ kind: "demand_gen", goal: "conversions" });
    expect(google({ channelType: "MULTI_CHANNEL" })).toMatchObject({ kind: "app", goal: "app" });
    expect(google({ channelType: "SEARCH", bidStrategy: "MANUAL_CPC" })).toMatchObject({ goal: "unknown", uncertain: true });
  });

  it("Google never compares CPA across campaign types", () => {
    // One Search campaign at 3x the CPA of two Performance Max campaigns: no same-type peers, no finding.
    const { campaigns, daily } = delivering(googleAccount, [
      { id: "search", channelType: "SEARCH", bidStrategy: "TARGET_CPA", perDay: { impressions: 2000, clicks: 100, spend: 900, conversions: 1 } },
      { id: "pmax1", channelType: "PERFORMANCE_MAX", perDay: { impressions: 4000, clicks: 80, spend: 900, conversions: 3 } },
      { id: "pmax2", channelType: "PERFORMANCE_MAX", perDay: { impressions: 4000, clicks: 80, spend: 900, conversions: 3 } },
    ]);
    const result = runAudit(engineInput({ accounts: [googleAccount], campaigns, daily, syncRuns: [run(GOOGLE)] }));
    expect(result.findings.filter((finding) => finding.ruleId === "efficiency.high_cpa_campaign")).toHaveLength(0);
    // With two other Search campaigns as peers, the outlier is found.
    const peers = delivering(googleAccount, [
      { id: "search", channelType: "SEARCH", bidStrategy: "TARGET_CPA", perDay: { impressions: 2000, clicks: 100, spend: 900, conversions: 1 } },
      { id: "s2", channelType: "SEARCH", bidStrategy: "TARGET_CPA", perDay: { impressions: 2000, clicks: 100, spend: 300, conversions: 1 } },
      { id: "s3", channelType: "SEARCH", bidStrategy: "TARGET_CPA", perDay: { impressions: 2000, clicks: 100, spend: 300, conversions: 1 } },
    ]);
    const withPeers = runAudit(engineInput({ accounts: [googleAccount], campaigns: peers.campaigns, daily: peers.daily, syncRuns: [run(GOOGLE)] }));
    expect(withPeers.findings.find((finding) => finding.ruleId === "efficiency.high_cpa_campaign")?.campaignId).toBe("search");
  });

  it("Meta awareness campaigns are not penalized for missing purchases; their CPM and frequency are evaluated", () => {
    const { campaigns, daily } = delivering(metaAccount, [
      { id: "aw1", objective: "OUTCOME_AWARENESS", perDay: { impressions: 20000, clicks: 30, spend: 3000, conversions: 0 }, platformPerDay: { link_clicks: 10, purchases: 0, leads: 0, app_installs: 0, purchase_value: 0 } },
      { id: "aw2", objective: "OUTCOME_AWARENESS", perDay: { impressions: 20000, clicks: 30, spend: 1000, conversions: 0 }, platformPerDay: { link_clicks: 10, purchases: 0, leads: 0, app_installs: 0, purchase_value: 0 } },
      { id: "aw3", objective: "OUTCOME_AWARENESS", perDay: { impressions: 20000, clicks: 30, spend: 1000, conversions: 0 }, platformPerDay: { link_clicks: 10, purchases: 0, leads: 0, app_installs: 0, purchase_value: 0 } },
    ]);
    const result = runAudit(engineInput({ accounts: [metaAccount], campaigns, daily, syncRuns: [run(META)] }));
    const ids = result.findings.map((finding) => finding.ruleId);
    expect(ids).not.toContain("tracking.no_conversions");
    expect(ids).not.toContain("tracking.no_conversion_value");
    expect(result.findings.find((finding) => finding.ruleId === "engagement.high_cpm")?.campaignId).toBe("aw1");
    expect(result.kpis.accounts[0].platformKpis).toMatchObject({ link_clicks: 900 });
  });

  it("Meta link CTR uses link clicks, never all clicks; without link clicks the check is unavailable", () => {
    const { campaigns, daily } = delivering(metaAccount, [
      { id: "m1", objective: "OUTCOME_TRAFFIC", perDay: { impressions: 1000, clicks: 50, spend: 100, conversions: 0 } },
      { id: "m2", objective: "OUTCOME_TRAFFIC", perDay: { impressions: 1000, clicks: 50, spend: 100, conversions: 0 } },
      { id: "m3", objective: "OUTCOME_TRAFFIC", perDay: { impressions: 1000, clicks: 50, spend: 100, conversions: 0 } },
    ]);
    const result = runAudit(engineInput({ accounts: [metaAccount], campaigns, daily, syncRuns: [run(META)] }));
    const skipped = result.kpis.scoring!.accounts[0].categories.engagement.skipped;
    expect(skipped).toContainEqual({ ruleId: "engagement.low_link_ctr", reason: "link clicks were not captured (re-sync)" });
    expect(result.findings.map((finding) => finding.ruleId)).not.toContain("engagement.low_ctr");
  });
});

describe("severity caps and cross-platform scores", () => {
  const googleDiagnostics = (primary: boolean) => [{
    adAccountId: GOOGLE, provider: "google" as const, windowStart: START, windowEnd: END, capturedAt: "2026-11-25T11:00:00Z",
    sections: { conversion_actions: { status: "ok" as const, rows: [{ id: "1", name: "Lead", status: "ENABLED", primary_for_goal: primary }] } },
  }];
  // Three Search campaigns with budgets, so tracking, engagement, structure and budget can be assessed.
  const searchAccount = (conversions: number) => delivering(googleAccount, ["s1", "s2", "s3"].map((id) => (
    { id, channelType: "SEARCH", bidStrategy: "TARGET_CPA", dailyBudget: 600, perDay: { impressions: 2000, clicks: 100, spend: 500, conversions } }
  )));

  it("a verified critical finding caps the account score at 59", () => {
    const { campaigns, daily } = searchAccount(0);
    const result = runAudit(engineInput({ accounts: [googleAccount], campaigns, daily, syncRuns: [run(GOOGLE)], diagnostics: googleDiagnostics(false) }));
    const account = result.kpis.scoring!.accounts[0];
    expect(result.findings.find((finding) => finding.ruleId === "tracking.no_conversions")).toMatchObject({ severity: "critical", basis: "verified" });
    expect(account.uncappedScore).toBeGreaterThan(59);
    expect(account.score).toBe(59);
    expect(account.cap).toMatchObject({ limit: 59, severity: "critical", ruleId: "tracking.no_conversions" });
    expect(account.reason).toContain("Capped at 59");
  });

  it("an indicative high finding does not cap; several low findings do not cap", () => {
    const { campaigns, daily } = searchAccount(0);
    const result = runAudit(engineInput({ accounts: [googleAccount], campaigns, daily, syncRuns: [run(GOOGLE)], diagnostics: googleDiagnostics(true) }));
    const account = result.kpis.scoring!.accounts[0];
    expect(result.findings.find((finding) => finding.ruleId === "tracking.no_conversions")).toMatchObject({ severity: "high", basis: "indicative" });
    expect(account.cap).toBeNull();
  });

  it("two platforms: no combined score, each platform scored on its own, nothing summed across platforms", async () => {
    const google = delivering(googleAccount, [
      { id: "s1", channelType: "SEARCH", bidStrategy: "TARGET_CPA", perDay: { impressions: 2000, clicks: 100, spend: 500, conversions: 5 } },
      { id: "s2", channelType: "SEARCH", bidStrategy: "TARGET_CPA", perDay: { impressions: 2000, clicks: 100, spend: 500, conversions: 5 } },
    ]);
    const meta = delivering(metaAccount, [
      { id: "m1", objective: "OUTCOME_LEADS", perDay: { impressions: 2000, clicks: 60, spend: 400, conversions: 4 }, platformPerDay: { link_clicks: 40, leads: 4, purchases: 0, app_installs: 0, purchase_value: 0 } },
      { id: "m2", objective: "OUTCOME_LEADS", perDay: { impressions: 2000, clicks: 60, spend: 400, conversions: 4 }, platformPerDay: { link_clicks: 40, leads: 4, purchases: 0, app_installs: 0, purchase_value: 0 } },
    ]);
    const result = runAudit(engineInput({
      accounts: [googleAccount, metaAccount],
      campaigns: [...google.campaigns, ...meta.campaigns],
      daily: [...google.daily, ...meta.daily],
      syncRuns: [run(GOOGLE), run(META)],
    }));
    expect(result.overallScore).toBeNull();
    expect(result.platformScores.google).toBeDefined();
    expect(result.platformScores.meta).toBeDefined();
    expect(result.kpis.totals).toBeNull();
    expect(result.categoryScores).toEqual({});
    expect(result.kpis.platformCategoryScores?.google).toBeDefined();
    expect(result.kpis.platformTotals?.google?.spend).toBe(30000);
    expect(result.kpis.platformTotals?.meta?.spend).toBe(24000);
    expect(result.summary).toContain("scored separately; no combined score");
    const payload = toSaveAuditPayload(result, { title: "A", periodStart: START, periodEnd: END, adAccountIds: [GOOGLE, META] });
    expect(payload.run.overall_score).toBeNull();
    expect(payload.run.platform_scores).toEqual(result.platformScores);
    // The PDF renders both platforms side by side (no combined ring).
    const data = toReportData({
      tenantName: "T",
      run: { id: "r", title: "A", period_start: START, period_end: END, status: "draft", engine_version: payload.run.engine_version, overall_score: null, platform_scores: payload.run.platform_scores, category_scores: payload.run.category_scores, kpis: payload.run.kpis as never, summary: payload.run.summary },
      findings: [],
      campaigns: [],
    });
    expect(data.platformScoring?.map((item) => item.provider)).toEqual(["google", "meta"]);
    expect(data.overallScore).toBeNull();
    const pdf = await PDFDocument.load(await buildAuditReportPdf(data));
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(4);
  });

  it("report data carries the same per-platform scores and statuses as the portal", () => {
    const { campaigns, daily } = searchAccount(5);
    const result = runAudit(engineInput({ accounts: [googleAccount], campaigns, daily, syncRuns: [run(GOOGLE)] }));
    const payload = toSaveAuditPayload(result, { title: "A", periodStart: START, periodEnd: END, adAccountIds: [GOOGLE] });
    const data = toReportData({
      tenantName: "T",
      run: { id: "r", title: "A", period_start: START, period_end: END, status: "draft", engine_version: payload.run.engine_version, overall_score: payload.run.overall_score, platform_scores: payload.run.platform_scores, category_scores: payload.run.category_scores, kpis: payload.run.kpis as never, summary: payload.run.summary },
      findings: [],
      campaigns: [],
    });
    expect(data.platformScoring).toEqual([{ provider: "google", score: result.platformScores.google ?? null, status: result.kpis.scoring!.platforms.google!.status, reason: result.kpis.scoring!.platforms.google!.reason }]);
    expect(data.platformCategoryScores?.google).toEqual(result.kpis.platformCategoryScores?.google);
  });
});

describe("legacy Meta data without platform metrics", () => {
  it("marks Meta result checks unavailable instead of using the combined conversions column", () => {
    const input = buildAuditInput({
      tenantName: "T", periodStart: START, periodEnd: END,
      accounts: [{ id: META, provider: "meta", account_name: "M", external_account_id: "act_1", currency: "INR" }],
      campaigns: [{ campaign_id: "c1", ad_account_id: META, provider: "meta", account_name: null, external_campaign_id: "1", campaign_name: "Leads", objective: "OUTCOME_LEADS", campaign_status: "ACTIVE", channel_type: null, bid_strategy: null, daily_budget: null, currency: "INR", impressions: 30000, reach: 20000, clicks: 600, spend: 9000, conversions: 0, conversion_value: 0, active_days: 30 }],
      daily: [],
      campaignDaily: Array.from({ length: 30 }, (_, index) => ({ campaign_id: "c1", ad_account_id: META, metric_date: addDays(START, index), impressions: 1000, reach: 700, clicks: 20, spend: 300, conversions: 0, conversion_value: 0, platform_metrics: null })),
    });
    expect(input.campaigns[0].platformMetrics).toBeNull();
    const result = runAudit({ ...input, generatedAt: "2026-11-26T00:00:00Z" });
    expect(result.findings.map((finding) => finding.ruleId)).not.toContain("tracking.no_conversions");
    expect(result.kpis.scoring!.accounts[0].categories.tracking.skipped[0].reason).toMatch(/result metrics per objective/);
    expect(result.kpis.limitations?.some((item) => item.includes("Re-sync to enable them"))).toBe(true);
  });
});
