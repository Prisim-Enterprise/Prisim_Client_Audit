// PRISIM advertising audit engine.
//
// Deterministic, side-effect free: the same input always produces the same
// findings and scores. Rules work on period totals per campaign and per-day
// totals per ad account, so they apply equally to Meta and Google data.
// Money is never summed across different currencies.

import {
  daysBetweenInclusive,
  formatMoney,
  formatMultiple,
  formatNumber,
  formatPercent,
  ratio,
  round,
} from "../format.ts";
import type {
  AccountKpis,
  AuditAccount,
  AuditCampaign,
  AuditDailyRow,
  AuditFinding,
  AuditInput,
  AuditResult,
  DerivedKpis,
  FindingCategory,
  Provider,
  Severity,
  Totals,
} from "./types.ts";

export const ENGINE_VERSION = "prisim-audit-1.0.0";

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
export const CATEGORIES: FindingCategory[] = [
  "tracking",
  "efficiency",
  "engagement",
  "structure",
  "budget",
  "trend",
  "data_quality",
];

const CATEGORY_WEIGHTS: Record<FindingCategory, number> = {
  tracking: 0.25,
  efficiency: 0.25,
  engagement: 0.15,
  structure: 0.1,
  budget: 0.1,
  trend: 0.1,
  data_quality: 0.05,
};

const SEVERITY_PENALTY: Record<Severity, number> = {
  critical: 35,
  high: 18,
  medium: 9,
  low: 4,
  info: 0,
};

/** CTR benchmarks by platform/channel (conservative industry medians). */
export function ctrBenchmark(provider: Provider, channelType: string | null): number {
  if (provider === "meta") return 0.009;
  switch ((channelType ?? "").toUpperCase()) {
    case "SEARCH":
      return 0.03;
    case "SHOPPING":
      return 0.007;
    case "DISPLAY":
    case "DISCOVERY":
    case "DEMAND_GEN":
      return 0.004;
    case "VIDEO":
      return 0.004;
    case "PERFORMANCE_MAX":
      return 0.006;
    default:
      return 0.01;
  }
}

const MANUAL_BIDDING = new Set(["MANUAL_CPC", "MANUAL_CPM", "MANUAL_CPV", "ENHANCED_CPC"]);
const ACTIVE_STATUSES = new Set(["ACTIVE", "ENABLED"]);

function emptyTotals(): Totals {
  return { impressions: 0, reach: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0 };
}

function addTotals(target: Totals, row: Totals) {
  target.impressions += row.impressions;
  target.reach += row.reach;
  target.clicks += row.clicks;
  target.spend += row.spend;
  target.conversions += row.conversions;
  target.conversionValue += row.conversionValue;
}

export function deriveKpis(totals: Totals): DerivedKpis {
  return {
    ...totals,
    spend: round(totals.spend, 4),
    conversions: round(totals.conversions, 4),
    conversionValue: round(totals.conversionValue, 4),
    ctr: ratio(totals.clicks, totals.impressions),
    cpc: ratio(totals.spend, totals.clicks),
    cpm: (() => {
      const value = ratio(totals.spend, totals.impressions);
      return value === null ? null : value * 1000;
    })(),
    cpa: ratio(totals.spend, totals.conversions),
    conversionRate: ratio(totals.conversions, totals.clicks),
    roas: ratio(totals.conversionValue, totals.spend),
  };
}

function isActive(campaign: AuditCampaign) {
  return ACTIVE_STATUSES.has((campaign.status ?? "").toUpperCase());
}

type Context = {
  input: AuditInput;
  periodDays: number;
  account: AuditAccount;
  kpis: AccountKpis;
  campaigns: AuditCampaign[];
  daily: AuditDailyRow[];
};

type Draft = Omit<AuditFinding, "platform" | "adAccountId" | "impactCurrency"> & {
  campaign?: AuditCampaign;
};

function money(ctx: Context, value: number | null) {
  return formatMoney(value, ctx.account.currency);
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

type Rule = (ctx: Context) => Draft[];

const noConversionTracking: Rule = (ctx) => {
  const { kpis } = ctx;
  if (kpis.spend <= 0 || kpis.conversions > 0 || kpis.clicks < 100) return [];
  return [{
    ruleId: "tracking.no_conversions",
    category: "tracking",
    severity: "critical",
    campaignId: null,
    title: `No conversions recorded for ${ctx.account.name}`,
    description:
      `${money(ctx, kpis.spend)} was spent and ${formatNumber(kpis.clicks)} clicks were received during the period, ` +
      "but no conversions were reported. Either conversion tracking is missing or broken, or campaigns are " +
      "optimizing toward actions that never complete.",
    recommendation:
      ctx.account.provider === "meta"
        ? "Verify the Meta Pixel and Conversions API events in Events Manager, confirm the optimization event fires on the thank-you page, and check event deduplication."
        : "Check Google Ads conversion actions (Tools > Conversions): confirm the tag or GA4 import is active, set the right primary actions, and test with Tag Assistant.",
    evidence: { spend: round(kpis.spend), clicks: kpis.clicks, conversions: 0 },
    estimatedImpact: round(kpis.spend),
  }];
};

const missingConversionValue: Rule = (ctx) => {
  const { kpis } = ctx;
  if (kpis.conversions < 10 || kpis.conversionValue > 0 || kpis.spend <= 0) return [];
  const salesObjective = ctx.campaigns.some((campaign) =>
    /SALES|CONVERSION|PURCHASE|SHOPPING|PERFORMANCE_MAX/i.test(`${campaign.objective ?? ""} ${campaign.channelType ?? ""}`)
  );
  if (!salesObjective) return [];
  return [{
    ruleId: "tracking.no_conversion_value",
    category: "tracking",
    severity: "medium",
    campaignId: null,
    title: "Conversion value is not being reported",
    description:
      `${formatNumber(kpis.conversions, 0)} conversions were recorded with no conversion value, ` +
      "so return on ad spend cannot be measured or optimized for sales-focused campaigns.",
    recommendation:
      "Pass purchase value and currency with every conversion event (or assign values to lead conversions) so value-based bidding and ROAS reporting become possible.",
    evidence: { conversions: round(kpis.conversions), conversion_value: 0 },
    estimatedImpact: null,
  }];
};

const campaignSpendWithoutConversions: Rule = (ctx) => {
  const { kpis } = ctx;
  if (kpis.conversions <= 0 || kpis.spend <= 0) return [];
  return ctx.campaigns
    .filter((campaign) => campaign.spend >= kpis.spend * 0.08 && campaign.conversions === 0 && campaign.clicks >= 50)
    .map((campaign) => ({
      ruleId: "efficiency.spend_without_conversions",
      category: "efficiency" as const,
      severity: "high" as const,
      campaignId: campaign.id,
      campaign,
      title: `"${campaign.name}" spent without converting`,
      description:
        `${money(ctx, campaign.spend)} (${formatPercent(campaign.spend / kpis.spend, 1)} of account spend) ` +
        `produced ${formatNumber(campaign.clicks)} clicks and no conversions, while the rest of the account converted.`,
      recommendation:
        "Pause or restructure this campaign: review targeting, search terms or audiences, landing page relevance and the optimization goal before reallocating budget to converting campaigns.",
      evidence: { spend: round(campaign.spend), clicks: campaign.clicks, conversions: 0 },
      estimatedImpact: round(campaign.spend),
    }));
};

const highCpaCampaign: Rule = (ctx) => {
  const accountCpa = ctx.kpis.cpa;
  if (accountCpa === null || ctx.kpis.conversions < 5) return [];
  return ctx.campaigns.flatMap((campaign) => {
    if (campaign.conversions < 1 || campaign.spend < ctx.kpis.spend * 0.05) return [];
    const cpa = campaign.spend / campaign.conversions;
    if (cpa < accountCpa * 2) return [];
    const excess = campaign.spend - campaign.conversions * accountCpa;
    return [{
      ruleId: "efficiency.high_cpa_campaign",
      category: "efficiency" as const,
      severity: (cpa >= accountCpa * 3 ? "high" : "medium") as Severity,
      campaignId: campaign.id,
      campaign,
      title: `"${campaign.name}" acquires customers at ${formatMultiple(cpa / accountCpa, 1)} the account average`,
      description:
        `Cost per acquisition is ${money(ctx, cpa)} against an account average of ${money(ctx, accountCpa)} ` +
        `across ${formatNumber(campaign.conversions, 0)} conversions.`,
      recommendation:
        "Tighten targeting to the best-converting audiences or keywords, test new creative or ad copy, and move budget toward campaigns at or below the account CPA.",
      evidence: {
        campaign_cpa: round(cpa),
        account_cpa: round(accountCpa),
        spend: round(campaign.spend),
        conversions: round(campaign.conversions),
      },
      estimatedImpact: round(Math.max(excess, 0)),
    }];
  });
};

const lowRoasCampaign: Rule = (ctx) => {
  if (ctx.kpis.conversionValue <= 0) return [];
  return ctx.campaigns.flatMap((campaign) => {
    if (campaign.spend < ctx.kpis.spend * 0.05 || campaign.conversions < 1) return [];
    const roas = campaign.conversionValue / campaign.spend;
    if (roas >= 1) return [];
    return [{
      ruleId: "efficiency.low_roas_campaign",
      category: "efficiency" as const,
      severity: "high" as const,
      campaignId: campaign.id,
      campaign,
      title: `"${campaign.name}" returns less than it spends`,
      description:
        `Return on ad spend is ${formatMultiple(roas)}: ${money(ctx, campaign.conversionValue)} of conversion value ` +
        `from ${money(ctx, campaign.spend)} of spend.`,
      recommendation:
        "Set a target ROAS, exclude low-value products or audiences, and review whether the reported conversion value reflects actual revenue.",
      evidence: { roas: round(roas), spend: round(campaign.spend), conversion_value: round(campaign.conversionValue) },
      estimatedImpact: round(campaign.spend - campaign.conversionValue),
    }];
  });
};

const accountRoas: Rule = (ctx) => {
  const { roas, conversionValue, spend } = ctx.kpis;
  if (roas === null || conversionValue <= 0 || roas >= 2) return [];
  return [{
    ruleId: "efficiency.account_roas",
    category: "efficiency",
    severity: roas < 1 ? "high" : "medium",
    campaignId: null,
    title: `Account return on ad spend is ${formatMultiple(roas)}`,
    description:
      `${ctx.account.name} generated ${money(ctx, conversionValue)} of conversion value from ${money(ctx, spend)} ` +
      "of spend. Most businesses need at least 2-3x ROAS to be profitable after margins.",
    recommendation:
      "Prioritize budget for the highest-ROAS campaigns, adopt value-based bidding where data volume allows, and confirm margin-based ROAS targets with the business.",
    evidence: { roas: round(roas), spend: round(spend), conversion_value: round(conversionValue) },
    estimatedImpact: null,
  }];
};

const lowCtr: Rule = (ctx) =>
  ctx.campaigns.flatMap((campaign) => {
    if (campaign.impressions < 5000) return [];
    const ctr = campaign.clicks / campaign.impressions;
    const benchmark = ctrBenchmark(campaign.provider, campaign.channelType);
    if (ctr >= benchmark) return [];
    const severe = ctr < benchmark * 0.5;
    return [{
      ruleId: "engagement.low_ctr",
      category: "engagement" as const,
      severity: (severe ? "medium" : "low") as Severity,
      campaignId: campaign.id,
      campaign,
      title: `"${campaign.name}" has a below-benchmark click-through rate`,
      description:
        `CTR is ${formatPercent(ctr)} on ${formatNumber(campaign.impressions)} impressions, against a benchmark of ` +
        `${formatPercent(benchmark, 1)} for ${campaign.provider === "meta" ? "Meta campaigns" : `${(campaign.channelType ?? "Google").toLowerCase()} campaigns`}.`,
      recommendation:
        campaign.provider === "meta"
          ? "Refresh creative (new hooks, formats and offers), check audience relevance and test placements; low CTR raises CPM and CPC."
          : "Improve ad relevance: tighten keyword-to-ad grouping, add responsive search ad variations and sitelinks, and add negative keywords.",
      evidence: { ctr: round(ctr * 100, 3), benchmark_ctr: round(benchmark * 100, 2), impressions: campaign.impressions },
      estimatedImpact: null,
    }];
  });

const highFrequency: Rule = (ctx) => {
  if (ctx.account.provider !== "meta") return [];
  return ctx.campaigns.flatMap((campaign) => {
    if (campaign.impressions < 10000 || campaign.reach <= 0) return [];
    const frequency = campaign.impressions / campaign.reach;
    if (frequency < 2.5) return [];
    return [{
      ruleId: "engagement.high_frequency",
      category: "engagement" as const,
      severity: (frequency >= 4 ? "high" : "medium") as Severity,
      campaignId: campaign.id,
      campaign,
      title: `"${campaign.name}" shows signs of ad fatigue`,
      description:
        `Average daily frequency is ${formatNumber(frequency, 1)} impressions per person. Repeated exposure ` +
        "usually lowers CTR and raises cost per result.",
      recommendation:
        "Broaden the audience or add lookalike/interest expansion, rotate in fresh creative, and cap frequency for awareness campaigns.",
      evidence: { frequency: round(frequency, 2), impressions: campaign.impressions, reach: campaign.reach },
      estimatedImpact: null,
    }];
  });
};

const lowConversionRate: Rule = (ctx) => {
  const { clicks, conversions, conversionRate } = ctx.kpis;
  if (clicks < 500 || conversions <= 0 || conversionRate === null || conversionRate >= 0.01) return [];
  return [{
    ruleId: "engagement.low_conversion_rate",
    category: "engagement",
    severity: "medium",
    campaignId: null,
    title: `Only ${formatPercent(conversionRate)} of clicks convert`,
    description:
      `${formatNumber(clicks)} clicks produced ${formatNumber(conversions, 0)} conversions. A conversion rate under 1% ` +
      "usually points to landing-page, offer or audience-intent problems rather than media buying.",
    recommendation:
      "Audit landing page speed and mobile experience, align page messaging with ad promises, simplify forms or checkout, and test stronger offers.",
    evidence: { conversion_rate: round(conversionRate * 100, 2), clicks, conversions: round(conversions) },
    estimatedImpact: null,
  }];
};

const spendConcentration: Rule = (ctx) => {
  const spending = ctx.campaigns.filter((campaign) => campaign.spend > 0);
  if (spending.length < 3 || ctx.kpis.spend <= 0) return [];
  const top = spending.reduce((best, campaign) => (campaign.spend > best.spend ? campaign : best));
  const share = top.spend / ctx.kpis.spend;
  if (share < 0.7) return [];
  return [{
    ruleId: "budget.spend_concentration",
    category: "budget",
    severity: "low",
    campaignId: top.id,
    campaign: top,
    title: `${formatPercent(share, 0)} of spend runs through one campaign`,
    description:
      `"${top.name}" accounts for ${money(ctx, top.spend)} of ${money(ctx, ctx.kpis.spend)}. Heavy concentration ` +
      "makes results fragile if that campaign's performance changes.",
    recommendation:
      "Keep a structured testing budget (10-20%) in other campaigns or audiences so new winners can be found before the main campaign saturates.",
    evidence: { top_campaign_share: round(share * 100, 1), campaigns_with_spend: spending.length },
    estimatedImpact: null,
  }];
};

const underspendingBudgets: Rule = (ctx) =>
  ctx.campaigns.flatMap((campaign) => {
    if (!isActive(campaign) || !campaign.dailyBudget || campaign.dailyBudget <= 0) return [];
    const averageDaily = campaign.spend / Math.max(ctx.periodDays, 1);
    if (averageDaily >= campaign.dailyBudget * 0.5) return [];
    return [{
      ruleId: "budget.underspend",
      category: "budget" as const,
      severity: "low" as const,
      campaignId: campaign.id,
      campaign,
      title: `"${campaign.name}" spends well below its daily budget`,
      description:
        `Average daily spend is ${money(ctx, averageDaily)} against a daily budget of ${money(ctx, campaign.dailyBudget)}. ` +
        "Delivery is limited by bids, audience size, ad approval or quality.",
      recommendation:
        "Check delivery diagnostics: widen targeting, raise bid caps or targets, resolve disapproved ads, or reallocate the unused budget.",
      evidence: { average_daily_spend: round(averageDaily), daily_budget: round(campaign.dailyBudget) },
      estimatedImpact: null,
    }];
  });

const fragmentation: Rule = (ctx) => {
  const spending = ctx.campaigns.filter((campaign) => campaign.spend > 0);
  if (spending.length < 8 || ctx.kpis.spend <= 0) return [];
  const tiny = spending.filter((campaign) => campaign.spend / ctx.kpis.spend < 0.03);
  if (tiny.length < spending.length / 2) return [];
  return [{
    ruleId: "structure.fragmentation",
    category: "structure",
    severity: "medium",
    campaignId: null,
    title: "Budget is fragmented across many small campaigns",
    description:
      `${tiny.length} of ${spending.length} spending campaigns each receive less than 3% of spend. Thin budgets ` +
      "slow down automated bidding and keep campaigns in the learning phase.",
    recommendation:
      "Consolidate campaigns with the same goal and audience, use fewer, larger ad sets or ad groups, and let automated bidding work with more data per campaign.",
    evidence: { small_campaigns: tiny.length, campaigns_with_spend: spending.length },
    estimatedImpact: null,
  }];
};

const limitedLearning: Rule = (ctx) => {
  if (ctx.account.provider !== "meta" || ctx.periodDays < 7) return [];
  const weeks = ctx.periodDays / 7;
  return ctx.campaigns.flatMap((campaign) => {
    if (campaign.spend < ctx.kpis.spend * 0.1 || campaign.conversions <= 0) return [];
    if (!/SALES|LEADS|CONVERSION|APP_PROMOTION/i.test(campaign.objective ?? "")) return [];
    const weekly = campaign.conversions / weeks;
    if (weekly >= 50) return [];
    return [{
      ruleId: "structure.limited_learning",
      category: "structure" as const,
      severity: (weekly < 10 ? "medium" : "low") as Severity,
      campaignId: campaign.id,
      campaign,
      title: `"${campaign.name}" may not exit the learning phase`,
      description:
        `The campaign averages ${formatNumber(weekly, 1)} conversions per week; Meta needs about 50 optimization ` +
        "events per ad set per week to stabilize delivery.",
      recommendation:
        "Consolidate ad sets, broaden audiences, or optimize for a higher-volume event earlier in the funnel until volume supports the final event.",
      evidence: { weekly_conversions: round(weekly, 1), conversions: round(campaign.conversions) },
      estimatedImpact: null,
    }];
  });
};

const manualBidding: Rule = (ctx) => {
  if (ctx.account.provider !== "google") return [];
  return ctx.campaigns.flatMap((campaign) => {
    const strategy = (campaign.bidStrategy ?? "").toUpperCase();
    if (!MANUAL_BIDDING.has(strategy) || campaign.conversions < 30) return [];
    return [{
      ruleId: "structure.manual_bidding",
      category: "structure" as const,
      severity: "medium" as const,
      campaignId: campaign.id,
      campaign,
      title: `"${campaign.name}" uses manual bidding despite strong conversion data`,
      description:
        `The campaign uses ${strategy.replace(/_/g, " ").toLowerCase()} and recorded ${formatNumber(campaign.conversions, 0)} ` +
        "conversions in the period, enough for Smart Bidding to learn from.",
      recommendation:
        "Test Maximize Conversions with a target CPA (or Maximize Conversion Value with a target ROAS) using a campaign experiment against the current setup.",
      evidence: { bid_strategy: strategy, conversions: round(campaign.conversions) },
      estimatedImpact: null,
    }];
  });
};

const inactiveCampaigns: Rule = (ctx) => {
  const idle = ctx.campaigns.filter((campaign) => isActive(campaign) && campaign.impressions === 0);
  if (idle.length === 0) return [];
  return [{
    ruleId: "structure.idle_campaigns",
    category: "structure",
    severity: "low",
    campaignId: null,
    title: `${idle.length} active campaign${idle.length === 1 ? "" : "s"} delivered no impressions`,
    description:
      `Campaigns marked active but not delivering: ${idle.slice(0, 5).map((campaign) => `"${campaign.name}"`).join(", ")}` +
      `${idle.length > 5 ? ` and ${idle.length - 5} more` : ""}.`,
    recommendation:
      "Check for disapproved ads, exhausted lifetime budgets, empty ad sets or ad groups, or end dates; pause campaigns that are no longer needed.",
    evidence: { idle_campaigns: idle.length },
    estimatedImpact: null,
  }];
};

function splitHalves(rows: AuditDailyRow[]) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const middle = Math.floor(sorted.length / 2);
  const first = emptyTotals();
  const second = emptyTotals();
  sorted.slice(0, middle).forEach((row) => addTotals(first, row));
  sorted.slice(middle).forEach((row) => addTotals(second, row));
  return { first, second };
}

const cpaTrend: Rule = (ctx) => {
  if (ctx.daily.length < 14) return [];
  const { first, second } = splitHalves(ctx.daily);
  if (first.conversions < 5 || second.conversions < 5) return [];
  const before = first.spend / first.conversions;
  const after = second.spend / second.conversions;
  if (after < before * 1.3) return [];
  return [{
    ruleId: "trend.cpa_rising",
    category: "trend",
    severity: after >= before * 1.6 ? "high" : "medium",
    campaignId: null,
    title: `Cost per acquisition rose ${formatPercent(after / before - 1, 0)} during the period`,
    description:
      `CPA moved from ${money(ctx, before)} in the first half of the period to ${money(ctx, after)} in the second half.`,
    recommendation:
      "Look for creative fatigue, rising competition (auction insights), tracking changes or budget increases that pushed delivery into less efficient inventory.",
    evidence: { cpa_first_half: round(before), cpa_second_half: round(after) },
    estimatedImpact: round(Math.max(second.spend - second.conversions * before, 0)),
  }];
};

const spendVolatility: Rule = (ctx) => {
  const days = ctx.daily.filter((row) => row.spend > 0);
  if (days.length < 14) return [];
  const mean = days.reduce((sum, row) => sum + row.spend, 0) / days.length;
  const variance = days.reduce((sum, row) => sum + (row.spend - mean) ** 2, 0) / days.length;
  const cv = Math.sqrt(variance) / mean;
  if (cv < 0.6) return [];
  return [{
    ruleId: "trend.spend_volatility",
    category: "trend",
    severity: "low",
    campaignId: null,
    title: "Daily spend is highly irregular",
    description:
      `Daily spend varies by ${formatPercent(cv, 0)} around an average of ${money(ctx, mean)}. Large swings disrupt ` +
      "algorithmic learning and make performance hard to read.",
    recommendation:
      "Avoid frequent large budget edits (keep changes under ~20% at a time), use campaign budget optimization or shared budgets, and schedule planned bursts.",
    evidence: { coefficient_of_variation: round(cv, 2), average_daily_spend: round(mean) },
    estimatedImpact: null,
  }];
};

const dataCoverage: Rule = (ctx) => {
  const dates = new Set(ctx.daily.map((row) => row.date));
  if (dates.size === 0) {
    return [{
      ruleId: "data_quality.no_data",
      category: "data_quality",
      severity: "info",
      campaignId: null,
      title: `No performance data for ${ctx.account.name}`,
      description: "No synced metrics exist for this ad account in the audit period.",
      recommendation:
        "Confirm the account is selected for sync and has delivered ads in the period, then run a sync before re-running the audit.",
      evidence: { days_with_data: 0, period_days: ctx.periodDays },
      estimatedImpact: null,
    }];
  }
  if (dates.size >= ctx.periodDays * 0.8) return [];
  return [{
    ruleId: "data_quality.missing_days",
    category: "data_quality",
    severity: "info",
    campaignId: null,
    title: `Data covers ${dates.size} of ${ctx.periodDays} days`,
    description:
      `${ctx.account.name} has no delivery or no synced data on ${ctx.periodDays - dates.size} days of the audit period. ` +
      "Results reflect only the days with data.",
    recommendation: "Check whether ads paused intentionally on those days; if not, re-run a backfill sync before publishing.",
    evidence: { days_with_data: dates.size, period_days: ctx.periodDays },
    estimatedImpact: null,
  }];
};

export const RULES: Rule[] = [
  noConversionTracking,
  missingConversionValue,
  campaignSpendWithoutConversions,
  highCpaCampaign,
  lowRoasCampaign,
  accountRoas,
  lowCtr,
  highFrequency,
  lowConversionRate,
  spendConcentration,
  underspendingBudgets,
  fragmentation,
  limitedLearning,
  manualBidding,
  inactiveCampaigns,
  cpaTrend,
  spendVolatility,
  dataCoverage,
];

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function penalty(finding: AuditFinding, spendShare: number | null) {
  const base = SEVERITY_PENALTY[finding.severity];
  if (spendShare === null) return base;
  // Campaign-level findings weigh by how much of the account they affect.
  return base * Math.min(Math.max(0.35 + spendShare, 0.35), 1);
}

export function scoreFindings(
  findings: Array<{ finding: AuditFinding; spendShare: number | null }>,
): { overall: number; categories: Record<FindingCategory, number> } {
  const categories = Object.fromEntries(CATEGORIES.map((category) => [category, 100])) as Record<FindingCategory, number>;
  for (const { finding, spendShare } of findings) {
    categories[finding.category] = Math.max(0, categories[finding.category] - penalty(finding, spendShare));
  }
  const overall = CATEGORIES.reduce((sum, category) => sum + categories[category] * CATEGORY_WEIGHTS[category], 0);
  for (const category of CATEGORIES) categories[category] = round(categories[category], 1);
  return { overall: round(overall, 1), categories };
}

function severityRank(severity: Severity) {
  return SEVERITY_ORDER.indexOf(severity);
}

export function sortFindings<T extends Pick<AuditFinding, "severity" | "estimatedImpact" | "title">>(findings: T[]): T[] {
  return [...findings].sort((a, b) =>
    severityRank(a.severity) - severityRank(b.severity)
    || (b.estimatedImpact ?? 0) - (a.estimatedImpact ?? 0)
    || a.title.localeCompare(b.title)
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function runAudit(input: AuditInput): AuditResult {
  const periodDays = daysBetweenInclusive(input.periodStart, input.periodEnd);
  if (periodDays <= 0) throw new Error("The audit period is invalid.");
  if (input.accounts.length === 0) throw new Error("Select at least one ad account to audit.");

  const accountKpis: AccountKpis[] = [];
  const scored: Array<{ finding: AuditFinding; spendShare: number | null }> = [];

  for (const account of input.accounts) {
    const campaigns = input.campaigns.filter((campaign) => campaign.adAccountId === account.id);
    const daily = input.daily.filter((row) => row.adAccountId === account.id && row.date >= input.periodStart && row.date <= input.periodEnd);
    const totals = emptyTotals();
    campaigns.forEach((campaign) => addTotals(totals, campaign));
    const kpis: AccountKpis = {
      ...deriveKpis(totals),
      adAccountId: account.id,
      provider: account.provider,
      name: account.name,
      currency: account.currency,
      campaignCount: campaigns.length,
      activeCampaignCount: campaigns.filter((campaign) => campaign.spend > 0 || campaign.impressions > 0).length,
    };
    accountKpis.push(kpis);

    const ctx: Context = { input, periodDays, account, kpis, campaigns, daily };
    for (const rule of RULES) {
      for (const draft of rule(ctx)) {
        const { campaign, ...rest } = draft;
        const finding: AuditFinding = {
          ...rest,
          platform: account.provider,
          adAccountId: account.id,
          impactCurrency: draft.estimatedImpact !== null ? account.currency : null,
        };
        const spendShare = campaign && kpis.spend > 0 ? campaign.spend / kpis.spend : null;
        scored.push({ finding, spendShare });
      }
    }
  }

  const findings = sortFindings(scored.map((item) => item.finding));
  const { overall, categories } = scoreFindings(scored);

  const platformScores: Partial<Record<Provider, number>> = {};
  for (const provider of ["meta", "google"] as const) {
    if (!input.accounts.some((account) => account.provider === provider)) continue;
    platformScores[provider] = scoreFindings(scored.filter((item) => item.finding.platform === provider)).overall;
  }

  const currencies = new Set(input.accounts.map((account) => account.currency ?? ""));
  const singleCurrency = currencies.size === 1 ? (input.accounts[0].currency ?? null) : null;
  let combined: DerivedKpis | null = null;
  if (currencies.size === 1) {
    const totals = emptyTotals();
    accountKpis.forEach((kpis) => addTotals(totals, kpis));
    combined = deriveKpis(totals);
  }
  const dataDays = new Set(
    input.daily.filter((row) => row.date >= input.periodStart && row.date <= input.periodEnd).map((row) => row.date),
  ).size;

  return {
    engineVersion: ENGINE_VERSION,
    overallScore: overall,
    platformScores,
    categoryScores: categories,
    kpis: { currency: singleCurrency, totals: combined, accounts: accountKpis, periodDays, dataDays },
    findings,
    summary: buildSummary(input, findings, overall, accountKpis, combined, singleCurrency),
  };
}

export function scoreLabel(score: number): string {
  if (score >= 85) return "Strong";
  if (score >= 70) return "Healthy with gaps";
  if (score >= 50) return "Needs attention";
  return "At risk";
}

function buildSummary(
  input: AuditInput,
  findings: AuditFinding[],
  overall: number,
  accounts: AccountKpis[],
  totals: DerivedKpis | null,
  currency: string | null,
): string {
  const urgent = findings.filter((finding) => finding.severity === "critical" || finding.severity === "high");
  const parts: string[] = [];
  const accountLabel = `${accounts.length} ad account${accounts.length === 1 ? "" : "s"}`;
  parts.push(
    `This audit reviewed ${accountLabel} for ${input.tenantName} from ${input.periodStart} to ${input.periodEnd}. ` +
      `The overall account health score is ${formatNumber(overall, 0)}/100 (${scoreLabel(overall).toLowerCase()}).`,
  );
  if (totals) {
    parts.push(
      `Total spend was ${formatMoney(totals.spend, currency)} for ${formatNumber(totals.conversions, 0)} conversions` +
        (totals.cpa !== null ? ` at ${formatMoney(totals.cpa, currency)} per conversion` : "") +
        (totals.roas !== null && totals.conversionValue > 0 ? ` and ${formatMultiple(totals.roas)} return on ad spend` : "") +
        ".",
    );
  }
  if (urgent.length === 0) {
    parts.push("No critical or high-priority issues were detected.");
  } else {
    parts.push(
      `${urgent.length} high-priority issue${urgent.length === 1 ? " needs" : "s need"} attention, led by: ${urgent[0].title}.`,
    );
    const impactByCurrency = new Map<string, number>();
    for (const finding of urgent) {
      if (finding.estimatedImpact && finding.impactCurrency) {
        impactByCurrency.set(finding.impactCurrency, (impactByCurrency.get(finding.impactCurrency) ?? 0) + finding.estimatedImpact);
      }
    }
    const impacts = [...impactByCurrency.entries()].map(([code, amount]) => formatMoney(amount, code, 0));
    if (impacts.length > 0) {
      parts.push(`An estimated ${impacts.join(" + ")} of spend is at risk across these issues.`);
    }
  }
  return parts.join(" ");
}
