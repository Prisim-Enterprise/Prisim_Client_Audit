// @vitest-environment node
// Client analytics and PDF tables: platform-specific metrics, objective-specific
// Meta results, unavailable historical data, currencies, and consistency with
// the audit engine and the analytics RPCs.
import { type AnalyticsCampaignRow, availableDailyMetrics, campaignView, dailySeries, summarizePlatforms } from "@functions/_shared/analytics/platform.ts";
import { runAudit } from "@functions/_shared/audit/engine.ts";
import { buildAuditInput, type CampaignDailyMetricRow, type CampaignPerformanceRow } from "@functions/_shared/audit/input.ts";
import { META_OBJECTIVE_FAMILY } from "@functions/_shared/audit/meta.ts";
import { addDays } from "@functions/_shared/format.ts";
import { toReportData } from "@functions/_shared/report/data.ts";
import { buildAuditReportPdf } from "@functions/_shared/report/pdf.ts";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import migration from "../../../supabase/migrations/20261126100000_audit_accuracy.sql?raw";

const GOOGLE = "a0000000-0000-4000-8000-000000000002";
const META = "a0000000-0000-4000-8000-000000000001";

let n = 0;
function row(overrides: Partial<CampaignPerformanceRow>): CampaignPerformanceRow {
  n += 1;
  return {
    campaign_id: `c${n}`, ad_account_id: overrides.provider === "meta" ? META : GOOGLE, provider: "google", account_name: null, external_campaign_id: `${n}`,
    campaign_name: `Campaign ${n}`, objective: null, campaign_status: "ACTIVE", channel_type: null, bid_strategy: null, daily_budget: null, currency: "INR",
    impressions: 10000, reach: 0, clicks: 300, spend: 3000, conversions: 20, conversion_value: 0, active_days: 30,
    metric_rows: 30, platform_metric_rows: overrides.provider === "meta" ? 30 : 0, platform_metrics: null,
    ...overrides,
  };
}

const meta = (objective: string, metrics: Record<string, number>, overrides: Partial<CampaignPerformanceRow> = {}) =>
  row({ provider: "meta", objective, clicks: 500, conversions: 99, platform_metrics: { link_clicks: 200, purchases: 0, leads: 0, registrations: 0, app_installs: 0, landing_page_views: 0, purchase_value: 0, ...metrics }, ...overrides });

describe("platform summaries", () => {
  it("mixed Google and Meta accounts are summarized separately; conversions are never combined", () => {
    const rows = [
      row({ provider: "google", conversions: 20, conversion_value: 9000, clicks: 300 }),
      meta("OUTCOME_LEADS", { leads: 12, purchases: 4 }),
    ];
    const summaries = summarizePlatforms(rows);
    expect(summaries.map((item) => item.provider)).toEqual(["google", "meta"]);
    const [google, metaSummary] = summaries;
    expect(google.google).toMatchObject({ conversions: 20, clicks: 300, roas: 3 });
    expect(google.meta).toBeUndefined();
    // Meta: link clicks (200), not all clicks (500); the legacy combined conversions (99) are not used.
    expect(metaSummary.meta).toMatchObject({ linkClicks: 200, linkCtr: 0.02, costPerLinkClick: 15 });
    expect(metaSummary.meta?.results).toEqual([{ family: "leads", label: "Leads", singular: "lead", campaigns: 1, spend: 3000, count: 12, cost: 250 }]);
    expect(metaSummary.google).toBeUndefined();
    expect(JSON.stringify(summaries)).not.toContain('"conversions":119');
  });

  it("Meta results follow each campaign's objective; purchase ROAS only for sales campaigns", () => {
    const summary = summarizePlatforms([
      meta("OUTCOME_SALES", { purchases: 10, purchase_value: 9000, leads: 7 }),
      meta("OUTCOME_LEADS", { leads: 20, purchases: 3, purchase_value: 600 }),
      meta("OUTCOME_APP_PROMOTION", { app_installs: 50 }),
      meta("OUTCOME_TRAFFIC", { link_clicks: 800 }),
      meta("OUTCOME_AWARENESS", { link_clicks: 10 }),
    ])[0].meta!;
    expect(summary.results.map((item) => [item.family, item.count])).toEqual([["sales", 10], ["leads", 20], ["app", 50]]);
    expect(summary.purchaseRoas).toBe(3); // 9000 / 3000 from the sales campaign only
    expect(campaignView(meta("OUTCOME_LEADS", { leads: 20, purchase_value: 600 }))).toMatchObject({ roasLabel: null, roas: null, result: { label: "Leads", count: 20 } });
    expect(campaignView(meta("OUTCOME_TRAFFIC", { link_clicks: 800 }))).toMatchObject({ result: { label: "Link clicks", count: 800, cost: 3.75 } });
    expect(campaignView(meta("OUTCOME_AWARENESS", {}))).toMatchObject({ result: null, roasLabel: null });
    expect(campaignView(meta("OUTCOME_SALES", { purchases: 10, purchase_value: 9000 }))).toMatchObject({ roasLabel: "Purchase ROAS", roas: 3, ctrLabel: "Link CTR", cpcLabel: "Cost / link click" });
  });

  it("historical Meta data without platform_metrics is Unavailable, never zero", () => {
    const legacy = meta("OUTCOME_LEADS", {}, { platform_metric_rows: 0, platform_metrics: null });
    const partial = meta("OUTCOME_LEADS", { leads: 5 }, { platform_metric_rows: 20 });
    for (const item of [legacy, partial]) {
      expect(campaignView(item)).toMatchObject({ available: false, ctr: null, cpc: null, result: { count: null, cost: null } });
    }
    const summary = summarizePlatforms([legacy, meta("OUTCOME_LEADS", { leads: 5 })])[0].meta!;
    expect(summary).toMatchObject({ linkClicks: null, linkCtr: null, unavailableCampaigns: 1 });
    expect(summary.results[0].count).toBeNull();
    // A campaign with no rows at all is exact (zero), not unavailable.
    expect(campaignView(meta("OUTCOME_LEADS", {}, { impressions: 0, spend: 0, metric_rows: 0, platform_metric_rows: 0, platform_metrics: null })).available).toBe(true);
    // Rows from an older API without coverage columns are unavailable.
    expect(campaignView(meta("OUTCOME_LEADS", { leads: 5 }, { metric_rows: undefined })).available).toBe(false);
  });

  it("multiple currencies are summarized per currency, never added", () => {
    const summaries = summarizePlatforms([
      row({ provider: "google", currency: "INR", spend: 3000 }),
      row({ provider: "google", currency: "USD", spend: 40 }),
      meta("OUTCOME_SALES", { purchases: 2, purchase_value: 100 }, { currency: "USD", spend: 50 }),
    ]);
    expect(summaries.map((item) => `${item.provider}:${item.currency}:${item.spend}`)).toEqual(["google:INR:3000", "google:USD:40", "meta:USD:50"]);
  });

  it("daily series keep platforms apart and show Meta gaps", () => {
    const dates = ["2026-11-01", "2026-11-02"];
    const daily = [
      { metric_date: "2026-11-01", provider: "google", currency: "INR", impressions: 100, clicks: 10, spend: 100, conversions: 2, conversion_value: 0, metric_rows: 1, platform_metric_rows: 0, platform_metrics: null },
      { metric_date: "2026-11-01", provider: "meta", currency: "INR", impressions: 100, clicks: 30, spend: 50, conversions: 9, conversion_value: 0, metric_rows: 2, platform_metric_rows: 2, platform_metrics: { link_clicks: 12, leads: 3 } },
      { metric_date: "2026-11-02", provider: "meta", currency: "INR", impressions: 100, clicks: 30, spend: 50, conversions: 9, conversion_value: 0, metric_rows: 2, platform_metric_rows: 1, platform_metrics: { link_clicks: 6, leads: 1 } },
    ];
    expect(dailySeries(daily, dates, "google_conversions").map((point) => point.value)).toEqual([2, 0]);
    expect(dailySeries(daily, dates, "meta_leads").map((point) => point.value)).toEqual([3, null]);
    expect(dailySeries(daily, dates, "meta_link_clicks").map((point) => point.value)).toEqual([12, null]);
    expect(dailySeries(daily, dates, "spend").map((point) => point.value)).toEqual([150, 50]);
    expect(availableDailyMetrics([row({ provider: "google" }), meta("OUTCOME_LEADS", {})])).toEqual(["spend", "google_conversions", "google_cost_per_conversion", "google_clicks", "meta_link_clicks", "meta_leads"]);
  });
});

describe("consistency with the audit engine, the RPCs and the PDF", () => {
  it("analytics Meta totals equal the audit engine's Meta KPIs for the same data", () => {
    const start = "2026-10-26";
    const campaigns = [
      meta("OUTCOME_SALES", { purchases: 30, purchase_value: 12000, link_clicks: 300 }, { campaign_id: "s", external_campaign_id: "s", spend: 3000 }),
      meta("OUTCOME_LEADS", { leads: 60, link_clicks: 450 }, { campaign_id: "l", external_campaign_id: "l", spend: 1800 }),
    ];
    const days = Array.from({ length: 30 }, (_, index) => addDays(start, index));
    const campaignDaily: CampaignDailyMetricRow[] = campaigns.flatMap((campaign) => days.map((date) => ({
      campaign_id: campaign.campaign_id, ad_account_id: META, metric_date: date,
      impressions: 10000 / 30, reach: 0, clicks: 500 / 30, spend: Number(campaign.spend) / 30, conversions: 0, conversion_value: 0,
      platform_metrics: Object.fromEntries(Object.entries(campaign.platform_metrics!).map(([key, value]) => [key, Number(value) / 30])),
    })));
    const input = buildAuditInput({
      tenantName: "T", periodStart: start, periodEnd: days.at(-1)!,
      accounts: [{ id: META, provider: "meta", account_name: "M", external_account_id: "act_1", currency: "INR" }],
      campaigns, daily: [], campaignDaily,
    });
    const engine = runAudit({ ...input, generatedAt: "2026-11-26T00:00:00Z" }).kpis.accounts[0].platformKpis!;
    const analytics = summarizePlatforms(campaigns)[0].meta!;
    expect(engine.link_clicks).toBeCloseTo(analytics.linkClicks!, 6);
    expect(engine.leads).toBeCloseTo(analytics.results.find((item) => item.family === "leads")!.count!, 6);
    expect(engine.purchases).toBeCloseTo(analytics.results.find((item) => item.family === "sales")!.count!, 6);
    expect(engine.purchase_roas).toBeCloseTo(analytics.purchaseRoas!, 6);
    expect(engine.cost_per_lead).toBeCloseTo(analytics.results.find((item) => item.family === "leads")!.cost!, 6);
  });

  it("the daily RPC counts Meta results with the same objective lists as the engine", () => {
    const daily = migration.slice(migration.indexOf("CREATE FUNCTION public.get_daily_performance"));
    for (const [family, key] of [["sales", "purchases"], ["leads", "leads"], ["app", "app_installs"]] as const) {
      const objectives = Object.entries(META_OBJECTIVE_FAMILY).filter(([, value]) => value === family).map(([objective]) => objective).sort();
      const match = new RegExp(`'${key}', COALESCE\\(sum\\(CASE WHEN upper\\(c\\.objective\\) IN \\(([^)]*)\\)`).exec(daily);
      expect(match, key).not.toBeNull();
      expect(match![1].split(",").map((item) => item.trim().replace(/'/g, "")).sort()).toEqual(objectives);
    }
  });

  it("the PDF tables use the same platform rules as the portal", async () => {
    const campaigns = [
      row({ provider: "google", ad_account_id: GOOGLE, conversions: 20, conversion_value: 9000 }),
      meta("OUTCOME_LEADS", { leads: 12 }, { ad_account_id: META }),
      meta("OUTCOME_SALES", {}, { ad_account_id: META, platform_metric_rows: 0, platform_metrics: null }),
    ];
    const data = toReportData({
      tenantName: "T",
      run: {
        id: "r", title: "A", period_start: "2026-10-26", period_end: "2026-11-24", status: "draft", engine_version: "prisim-audit-2.1.0", overall_score: null, platform_scores: {}, category_scores: {},
        kpis: { accounts: [{ adAccountId: GOOGLE, name: "G", provider: "google", currency: "INR", spend: 3000, conversions: 20 }, { adAccountId: META, name: "M", provider: "meta", currency: "INR", spend: 6000, conversions: 198 }] },
        summary: null,
      },
      findings: [],
      campaigns,
    });
    expect(data.platformSummaries).toEqual(summarizePlatforms(campaigns as AnalyticsCampaignRow[]));
    expect(data.accounts.map((account) => account.keyResult)).toEqual(["20 conversions", "Purchases: Unavailable, 12 leads"]);
    expect(data.accounts[1].roas).toBeNull(); // purchase ROAS unavailable (sales campaign without platform metrics)
    expect(data.campaigns.map((campaign) => campaign.resultText)).toEqual(["20 conversions", "12 leads", "Unavailable"]);
    expect(data.campaigns[1]).toMatchObject({ ctrLabel: "Link CTR", ctr: 0.02, roasLabel: null });
    expect(data.campaigns[0]).toMatchObject({ ctrLabel: "CTR", ctr: 0.03, roasLabel: "ROAS", roas: 3 });
    const pdf = await PDFDocument.load(await buildAuditReportPdf(data));
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(4);
  });
});
