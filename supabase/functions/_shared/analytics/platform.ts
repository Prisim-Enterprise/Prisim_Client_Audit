// Platform-specific analytics shared by the portal (dashboard, campaign pages)
// and the PDF report. Same rules as the audit engine:
//   - Google and Meta are summarized separately; their conversions, clicks and
//     money are never added together. Money is only summed within one currency.
//   - Google: clicks, CTR, CPC, conversions, cost per conversion, ROAS.
//   - Meta: link clicks, link CTR and cost per link click (not all clicks);
//     purchases, leads and app installs only from campaigns whose objective has
//     that result (audit/meta.ts classification); purchase ROAS only for sales
//     campaigns.
//   - Meta platform metrics that were not captured for every row of a
//     campaign (data synced before platform_metrics existed) are unavailable
//     (null), never zero.

import { metaObjectiveFamily } from "../audit/meta.ts";

export type AnalyticsProvider = "meta" | "google";

/** Shape of get_campaign_performance rows (numbers may arrive as strings from PostgREST). */
export type AnalyticsCampaignRow = {
  provider: string;
  objective: string | null;
  currency: string | null;
  impressions: number | string;
  clicks: number | string;
  spend: number | string;
  conversions: number | string;
  conversion_value: number | string;
  metric_rows?: number | string | null;
  platform_metric_rows?: number | string | null;
  platform_metrics?: Record<string, unknown> | null;
};

/** Shape of get_daily_performance rows. */
export type AnalyticsDailyRow = {
  metric_date: string;
  provider: string;
  currency: string | null;
  impressions: number | string;
  clicks: number | string;
  spend: number | string;
  conversions: number | string;
  conversion_value: number | string;
  metric_rows?: number | string | null;
  platform_metric_rows?: number | string | null;
  platform_metrics?: Record<string, unknown> | null;
};

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function ratio(a: number | null, b: number | null): number | null {
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return a / b;
}

/** Objective families whose result is counted, with the platform_metrics key. */
export const META_RESULT_FAMILIES = [
  { family: "sales", key: "purchases", label: "Purchases", singular: "purchase" },
  { family: "leads", key: "leads", label: "Leads", singular: "lead" },
  { family: "app", key: "app_installs", label: "App installs", singular: "install" },
] as const;

/**
 * True when every row of the campaign/day carries platform metrics. Rows
 * without the coverage columns (older API) are treated as not covered.
 */
export function platformMetricsAvailable(row: { metric_rows?: unknown; platform_metric_rows?: unknown; platform_metrics?: unknown }): boolean {
  if (row.metric_rows === undefined || row.metric_rows === null) return false;
  const rows = num(row.metric_rows);
  if (rows === 0) return true; // no rows: nothing was delivered or recorded; zeros are exact
  return num(row.platform_metric_rows) === rows && Boolean(row.platform_metrics);
}

function metric(row: { platform_metrics?: Record<string, unknown> | null }, key: string): number {
  return num(row.platform_metrics?.[key]);
}

function delivered(row: AnalyticsCampaignRow) {
  return num(row.impressions) > 0 || num(row.spend) > 0;
}

export type CampaignView = {
  provider: AnalyticsProvider;
  /** Meta objective family (sales, leads, ...) or null for Google. */
  family: string | null;
  ctrLabel: "CTR" | "Link CTR";
  ctr: number | null;
  cpcLabel: "CPC" | "Cost / link click";
  cpc: number | null;
  /** The campaign's own result; null when its objective has no result metric (awareness, engagement). */
  result: { label: string; singular: string; count: number | null; cost: number | null } | null;
  roasLabel: "ROAS" | "Purchase ROAS" | null;
  /** null = not applicable or unavailable (see roasLabel and available). */
  roas: number | null;
  /** False for Meta campaigns whose platform metrics are incomplete (shown as "Unavailable"). */
  available: boolean;
};

export function campaignView(row: AnalyticsCampaignRow): CampaignView {
  const spend = num(row.spend);
  const impressions = num(row.impressions);
  if (row.provider !== "meta") {
    const conversions = num(row.conversions);
    const value = num(row.conversion_value);
    return {
      provider: "google",
      family: null,
      ctrLabel: "CTR",
      ctr: ratio(num(row.clicks), impressions),
      cpcLabel: "CPC",
      cpc: ratio(spend, num(row.clicks)),
      result: { label: "Conversions", singular: "conversion", count: conversions, cost: ratio(spend, conversions) },
      roasLabel: "ROAS",
      roas: value > 0 ? ratio(value, spend) : null,
      available: true,
    };
  }
  const available = platformMetricsAvailable(row);
  const family = metaObjectiveFamily(row.objective);
  const links = available ? metric(row, "link_clicks") : null;
  const resultFamily = META_RESULT_FAMILIES.find((item) => item.family === family);
  const result = resultFamily
    ? { label: resultFamily.label, singular: resultFamily.singular, count: available ? metric(row, resultFamily.key) : null, cost: available ? ratio(spend, metric(row, resultFamily.key)) : null }
    : family === "traffic"
    ? { label: "Link clicks", singular: "link click", count: links, cost: ratio(spend, links) }
    : null;
  return {
    provider: "meta",
    family,
    ctrLabel: "Link CTR",
    ctr: ratio(links, impressions),
    cpcLabel: "Cost / link click",
    cpc: ratio(spend, links),
    result,
    roasLabel: family === "sales" ? "Purchase ROAS" : null,
    roas: family === "sales" && available ? ratio(metric(row, "purchase_value"), spend) : null,
    available,
  };
}

export type PlatformSummary = {
  provider: AnalyticsProvider;
  /** Single currency of the group; summaries are split by currency. */
  currency: string | null;
  campaigns: number;
  spend: number;
  impressions: number;
  cpm: number | null;
  google?: {
    clicks: number;
    ctr: number | null;
    cpc: number | null;
    conversions: number;
    costPerConversion: number | null;
    conversionRate: number | null;
    conversionValue: number;
    roas: number | null;
  };
  meta?: {
    /** null when any delivering campaign lacks platform metrics. */
    linkClicks: number | null;
    linkCtr: number | null;
    costPerLinkClick: number | null;
    /** One entry per objective family present; count/cost null when unavailable. */
    results: Array<{ family: string; label: string; singular: string; campaigns: number; spend: number; count: number | null; cost: number | null }>;
    purchaseRoas: number | null;
    /** Delivering campaigns without complete platform metrics. */
    unavailableCampaigns: number;
  };
};

/** Platform summaries, one per provider and currency. Never combines Google and Meta. */
export function summarizePlatforms(rows: AnalyticsCampaignRow[]): PlatformSummary[] {
  const groups = new Map<string, AnalyticsCampaignRow[]>();
  for (const row of rows) {
    const provider = row.provider === "meta" ? "meta" : "google";
    const key = `${provider}|${row.currency ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const order = (key: string) => (key.startsWith("google") ? 0 : 1);
  return [...groups.entries()].sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b)).map(([key, group]) => {
    const [provider, currency] = key.split("|") as [AnalyticsProvider, string];
    const spend = group.reduce((sum, row) => sum + num(row.spend), 0);
    const impressions = group.reduce((sum, row) => sum + num(row.impressions), 0);
    const base: PlatformSummary = { provider, currency: currency || null, campaigns: group.length, spend, impressions, cpm: impressions > 0 ? (spend / impressions) * 1000 : null };
    if (provider === "google") {
      const clicks = group.reduce((sum, row) => sum + num(row.clicks), 0);
      const conversions = group.reduce((sum, row) => sum + num(row.conversions), 0);
      const value = group.reduce((sum, row) => sum + num(row.conversion_value), 0);
      base.google = {
        clicks,
        ctr: ratio(clicks, impressions),
        cpc: ratio(spend, clicks),
        conversions,
        costPerConversion: ratio(spend, conversions),
        conversionRate: ratio(conversions, clicks),
        conversionValue: value,
        roas: value > 0 ? ratio(value, spend) : null,
      };
      return base;
    }
    const deliveringUnavailable = group.filter((row) => delivered(row) && !platformMetricsAvailable(row));
    const linkClicks = deliveringUnavailable.length > 0 ? null : group.reduce((sum, row) => sum + metric(row, "link_clicks"), 0);
    const results = META_RESULT_FAMILIES.flatMap((item) => {
      const campaigns = group.filter((row) => metaObjectiveFamily(row.objective) === item.family);
      if (campaigns.length === 0) return [];
      const familySpend = campaigns.reduce((sum, row) => sum + num(row.spend), 0);
      const missing = campaigns.some((row) => delivered(row) && !platformMetricsAvailable(row));
      const count = missing ? null : campaigns.reduce((sum, row) => sum + metric(row, item.key), 0);
      return [{ family: item.family, label: item.label, singular: item.singular, campaigns: campaigns.length, spend: familySpend, count, cost: ratio(familySpend, count) }];
    });
    const sales = group.filter((row) => metaObjectiveFamily(row.objective) === "sales");
    const salesMissing = sales.some((row) => delivered(row) && !platformMetricsAvailable(row));
    const salesSpend = sales.reduce((sum, row) => sum + num(row.spend), 0);
    base.meta = {
      linkClicks,
      linkCtr: ratio(linkClicks, impressions),
      costPerLinkClick: ratio(spend, linkClicks),
      results,
      purchaseRoas: sales.length === 0 || salesMissing ? null : ratio(sales.reduce((sum, row) => sum + metric(row, "purchase_value"), 0), salesSpend),
      unavailableCampaigns: deliveringUnavailable.length,
    };
    return base;
  });
}

export type DailyMetric =
  | "spend"
  | "google_conversions"
  | "google_cost_per_conversion"
  | "google_clicks"
  | "meta_link_clicks"
  | "meta_purchases"
  | "meta_leads"
  | "meta_app_installs";

export const DAILY_METRIC_LABEL: Record<DailyMetric, string> = {
  spend: "Spend",
  google_conversions: "Google conversions",
  google_cost_per_conversion: "Google cost / conversion",
  google_clicks: "Google clicks",
  meta_link_clicks: "Meta link clicks",
  meta_purchases: "Meta purchases",
  meta_leads: "Meta leads",
  meta_app_installs: "Meta app installs",
};

/**
 * Daily series for one metric. Spend covers the given rows (callers pass one
 * currency). Platform metrics use only that platform's rows; a Meta day whose
 * rows are not all covered by platform metrics is null (a gap, not zero).
 */
export function dailySeries(rows: AnalyticsDailyRow[], dates: string[], metricName: DailyMetric): Array<{ date: string; value: number | null }> {
  const byDate = new Map<string, AnalyticsDailyRow[]>();
  for (const row of rows) byDate.set(row.metric_date, [...(byDate.get(row.metric_date) ?? []), row]);
  return dates.map((date) => {
    const day = byDate.get(date) ?? [];
    if (metricName === "spend") return { date, value: day.reduce((sum, row) => sum + num(row.spend), 0) };
    if (metricName.startsWith("google_")) {
      const google = day.filter((row) => row.provider !== "meta");
      const conversions = google.reduce((sum, row) => sum + num(row.conversions), 0);
      if (metricName === "google_conversions") return { date, value: conversions };
      if (metricName === "google_clicks") return { date, value: google.reduce((sum, row) => sum + num(row.clicks), 0) };
      return { date, value: ratio(google.reduce((sum, row) => sum + num(row.spend), 0), conversions) };
    }
    const meta = day.filter((row) => row.provider === "meta");
    if (meta.some((row) => !platformMetricsAvailable(row))) return { date, value: null };
    const keys: Record<string, string> = { meta_link_clicks: "link_clicks", meta_purchases: "purchases", meta_leads: "leads", meta_app_installs: "app_installs" };
    const key = keys[metricName];
    return { date, value: meta.reduce((sum, row) => sum + metric(row, key), 0) };
  });
}

/** Daily metrics worth offering for these campaigns (only platforms and objectives present). */
export function availableDailyMetrics(campaigns: AnalyticsCampaignRow[]): DailyMetric[] {
  const metrics: DailyMetric[] = ["spend"];
  if (campaigns.some((row) => row.provider !== "meta")) metrics.push("google_conversions", "google_cost_per_conversion", "google_clicks");
  const meta = campaigns.filter((row) => row.provider === "meta");
  if (meta.length > 0) {
    metrics.push("meta_link_clicks");
    const families = new Set(meta.map((row) => metaObjectiveFamily(row.objective)));
    if (families.has("sales")) metrics.push("meta_purchases");
    if (families.has("leads")) metrics.push("meta_leads");
    if (families.has("app")) metrics.push("meta_app_installs");
  }
  return metrics;
}
