// Audit rules (engine 2.0). Every rule declares when it can be evaluated
// (`applies`), so a category is only scored when at least one of its checks
// had enough evidence. Every finding states what was observed, which
// threshold was crossed, the period, the data source and what was unavailable.
//
// Thresholds are PRISIM heuristics unless a finding says otherwise; they are
// listed in THRESHOLDS so the methodology can be published with the report.

import { daysBetweenInclusive, formatMoney, formatMultiple, formatNumber, formatPercent, ratio, round } from "../format.ts";
import { campaignGoal, campaignKind, conversionsImported, expectsConversions, expectsRevenue, isEnabled, KIND_LABEL } from "./classify.ts";
import type { AccountQuality } from "./quality.ts";
import type {
  AccountDiagnosticsInput,
  AccountKpis,
  AuditAccount,
  AuditCampaign,
  AuditFinding,
  AuditInput,
  Benchmark,
  BusinessTarget,
  CampaignGoal,
  FindingBasis,
  FindingCategory,
  FindingEvidence,
  Scalar,
  Severity,
} from "./types.ts";

export const THRESHOLDS = {
  /** Clicks a conversion-focused account needs before zero conversions is meaningful. */
  minClicksForZeroConversions: 100,
  minCampaignClicksForZeroConversions: 50,
  minCampaignSpendShare: 0.08,
  minConversionsForCpa: 5,
  minAccountConversionsForCpa: 10,
  cpaOutlierMultiple: 2,
  cpaSevereMultiple: 3,
  minConversionsForValueCheck: 10,
  minImpressionsForCtr: 5000,
  minPeersForCtr: 2,
  ctrPeerFraction: 0.5,
  minImpressionsForFrequency: 10000,
  frequencyHigh: 2.5,
  frequencySevere: 4,
  minClicksForConversionRate: 300,
  conversionRatePeerFraction: 0.5,
  underspendFraction: 0.5,
  minEligibleDays: 7,
  concentrationShare: 0.7,
  fragmentationMinCampaigns: 8,
  fragmentationSmallShare: 0.03,
  manualBiddingMinConversions: 30,
  trendMinDaysPerHalf: 7,
  trendMinConversionsPerHalf: 10,
  trendCpaRise: 0.3,
  trendCpaSevereRise: 0.6,
  volatilityMinDays: 14,
  volatilityCv: 0.6,
  lowQualityScore: 4,
  lowQualityCostShare: 0.1,
  searchTermMinClicks: 10,
  searchTermCostShare: 0.1,
  budgetLostShare: 0.2,
  rankLostShare: 0.3,
  minImpressionsForImpressionShare: 1000,
} as const;

export type RuleContext = {
  input: AuditInput;
  period: { start: string; end: string; days: number };
  account: AuditAccount;
  kpis: AccountKpis;
  campaigns: AuditCampaign[];
  quality: AccountQuality;
  diagnostics: AccountDiagnosticsInput | null;
  target: BusinessTarget | null;
  benchmarks: Benchmark[];
};

export type Draft = {
  ruleId: string;
  category: FindingCategory;
  severity: Severity;
  basis: FindingBasis;
  campaign?: AuditCampaign;
  title: string;
  description: string;
  recommendation: string;
  observed: Record<string, Scalar>;
  thresholds: Record<string, Scalar>;
  source?: string;
  unavailable?: string[];
  reference?: string;
  estimatedImpact?: number | null;
  estimateLabel?: string | null;
  /** Findings with the same group on the same campaign are penalized once (highest). */
  scoringGroup?: string;
};

export type Rule = {
  id: string;
  category: FindingCategory;
  /** null = the rule could be evaluated; otherwise why it could not. */
  applies(ctx: RuleContext): string | null;
  run(ctx: RuleContext): Draft[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function money(ctx: RuleContext, value: number | null) {
  return formatMoney(value, ctx.account.currency);
}

function goalOf(ctx: RuleContext, campaign: AuditCampaign): CampaignGoal | "unknown" {
  return campaignGoal(campaign, ctx.target ?? undefined);
}

function delivered(campaign: AuditCampaign) {
  return campaign.impressions > 0 || campaign.spend > 0;
}

function dateOnly(value: string | null | undefined) {
  const match = value ? /^(\d{4}-\d{2}-\d{2})/.exec(value) : null;
  return match ? match[1] : null;
}

/** Period days the campaign could have run (from its start/end, when reported) that are known for the account. */
export function eligibleDays(ctx: RuleContext, campaign: AuditCampaign) {
  const start = dateOnly(campaign.details?.start);
  const end = dateOnly(campaign.details?.end);
  let known = 0;
  let retrieved = 0;
  for (const [date, state] of ctx.quality.days) {
    if (start && date < start) continue;
    if (end && date > end) continue;
    if (state !== "missing") known += 1;
    if (state === "rows" || state === "zero") retrieved += 1;
  }
  const scheduleKnown = Boolean(start);
  const notStarted = start !== null && start > ctx.period.end;
  const endedBefore = end !== null && end < ctx.period.start;
  return { known, retrieved, start, end, scheduleKnown, notStarted, endedBefore };
}

function diagnosticsSection(ctx: RuleContext, name: string) {
  const section = ctx.diagnostics?.sections[name];
  return section ?? null;
}

function diagnosticsSource(ctx: RuleContext) {
  const d = ctx.diagnostics;
  return d ? `platform diagnostics ${d.windowStart} to ${d.windowEnd} (captured ${d.capturedAt.slice(0, 16).replace("T", " ")} UTC)` : "platform diagnostics";
}

/** True when the diagnostics window covers at least half of the audit period. */
function diagnosticsAligned(ctx: RuleContext) {
  const d = ctx.diagnostics;
  if (!d) return false;
  const start = d.windowStart > ctx.period.start ? d.windowStart : ctx.period.start;
  const end = d.windowEnd < ctx.period.end ? d.windowEnd : ctx.period.end;
  if (end < start) return false;
  return daysBetweenInclusive(start, end) >= ctx.period.days / 2;
}

function diagnosticsCaveat(ctx: RuleContext): string[] {
  return diagnosticsAligned(ctx) ? [] : ["diagnostics window does not match the audit period"];
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function statusNote(campaign: AuditCampaign) {
  const captured = campaign.details?.capturedAt ? ` at ${campaign.details.capturedAt.slice(0, 10)}` : " at the last sync";
  return `${campaign.status ?? "unknown"}${captured}`;
}

function primaryReasons(campaign: AuditCampaign) {
  const reasons = campaign.details?.primaryStatusReasons ?? [];
  return reasons.length > 0 ? reasons.join(", ") : null;
}

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

type ConversionSetup =
  | { status: "unavailable"; reason: string }
  | { status: "ok"; enabled: number; primary: number; names: string[]; leadManyPerClick: string[]; purchaseActions: number };

const LEAD_CATEGORIES = new Set([
  "SUBMIT_LEAD_FORM", "CONTACT", "PHONE_CALL_LEAD", "IMPORTED_LEAD", "QUALIFIED_LEAD", "CONVERTED_LEAD", "BOOK_APPOINTMENT", "REQUEST_QUOTE", "GET_DIRECTIONS", "SIGNUP",
]);

export function googleConversionSetup(ctx: RuleContext): ConversionSetup {
  const section = diagnosticsSection(ctx, "conversion_actions");
  if (!section) return { status: "unavailable", reason: "conversion actions were not captured" };
  if (section.status !== "ok") return { status: "unavailable", reason: section.reason };
  const enabled = section.rows.filter((row) => row.status === "ENABLED");
  const primary = enabled.filter((row) => row.primary_for_goal !== false && row.include_in_conversions_metric !== false);
  return {
    status: "ok",
    enabled: enabled.length,
    primary: primary.length,
    names: primary.map((row) => String(row.name ?? row.id ?? "")).slice(0, 5),
    leadManyPerClick: primary.filter((row) => LEAD_CATEGORIES.has(String(row.category)) && row.counting_type === "MANY_PER_CLICK").map((row) => String(row.name ?? row.id)),
    purchaseActions: primary.filter((row) => row.category === "PURCHASE").length,
  };
}

type PixelSetup = { status: "unavailable"; reason: string } | { status: "ok"; pixels: number; lastFired: string | null; unavailable: number };

function metaPixelSetup(ctx: RuleContext): PixelSetup {
  const section = diagnosticsSection(ctx, "pixels");
  if (!section) return { status: "unavailable", reason: "pixels were not captured" };
  if (section.status !== "ok") return { status: "unavailable", reason: section.reason };
  const fired = section.rows.map((row) => (typeof row.last_fired_time === "string" ? row.last_fired_time : null)).filter((value): value is string => value !== null).sort();
  return { status: "ok", pixels: section.rows.length, lastFired: fired.at(-1) ?? null, unavailable: section.rows.filter((row) => row.is_unavailable === true).length };
}

function conversionCampaigns(ctx: RuleContext) {
  return ctx.campaigns.filter((campaign) => {
    const goal = goalOf(ctx, campaign);
    return expectsConversions(goal) && conversionsImported(campaign, goal);
  });
}

const noConversions: Rule = {
  id: "tracking.no_conversions",
  category: "tracking",
  applies(ctx) {
    const relevant = conversionCampaigns(ctx);
    if (relevant.length === 0) return "no conversion-focused campaigns with imported conversions";
    const clicks = relevant.reduce((sum, campaign) => sum + campaign.clicks, 0);
    const setup = ctx.account.provider === "google" ? googleConversionSetup(ctx) : null;
    if (clicks < THRESHOLDS.minClicksForZeroConversions && !(setup?.status === "ok" && setup.primary === 0)) {
      return `fewer than ${THRESHOLDS.minClicksForZeroConversions} clicks on conversion-focused campaigns`;
    }
    return null;
  },
  run(ctx) {
    const relevant = conversionCampaigns(ctx);
    const spend = relevant.reduce((sum, campaign) => sum + campaign.spend, 0);
    const clicks = relevant.reduce((sum, campaign) => sum + campaign.clicks, 0);
    const conversions = relevant.reduce((sum, campaign) => sum + campaign.conversions, 0);
    if (conversions > 0 || spend <= 0) return [];
    const unknownGoal = relevant.filter((campaign) => goalOf(ctx, campaign) === "unknown").length;
    const unavailable: string[] = [];
    if (unknownGoal > 0) unavailable.push(`campaign goal for ${unknownGoal} campaign(s)`);
    const observed: Record<string, Scalar> = { spend: round(spend), clicks, conversions: 0, campaigns: relevant.length };
    const thresholds: Record<string, Scalar> = { min_clicks: THRESHOLDS.minClicksForZeroConversions };

    if (ctx.account.provider === "google") {
      const setup = googleConversionSetup(ctx);
      if (setup.status === "ok" && setup.primary === 0) {
        return [{
          ruleId: "tracking.no_conversions",
          category: "tracking",
          severity: "critical",
          basis: "verified",
          title: `No enabled primary conversion action in ${ctx.account.name}`,
          description:
            `The account has ${setup.enabled} enabled conversion action(s) and none counts as a primary conversion, while ` +
            `${money(ctx, spend)} was spent on ${relevant.length} conversion-focused campaign(s) with ${formatNumber(clicks)} clicks and 0 conversions.`,
          recommendation:
            "In Google Ads (Goals > Conversions), create or enable the conversion actions that represent business results and mark them as primary, then confirm they record test conversions.",
          observed: { ...observed, enabled_conversion_actions: setup.enabled, primary_conversion_actions: 0 },
          thresholds,
          source: `daily metrics and ${diagnosticsSource(ctx)}`,
          unavailable: [...unavailable, ...diagnosticsCaveat(ctx)],
          estimatedImpact: round(spend),
          estimateLabel: "Spend with no conversion measurement",
        }];
      }
      if (clicks < THRESHOLDS.minClicksForZeroConversions) return [];
      return [{
        ruleId: "tracking.no_conversions",
        category: "tracking",
        severity: "high",
        basis: "indicative",
        title: `No conversions recorded for ${ctx.account.name}`,
        description:
          `${money(ctx, spend)} and ${formatNumber(clicks)} clicks on conversion-focused campaigns produced 0 recorded conversions. ` +
          (setup.status === "ok"
            ? `${setup.primary} primary conversion action(s) are enabled (${setup.names.join(", ")}), so tracking is configured; zero conversions can mean the tag is not firing, conversions are attributed elsewhere, or the traffic did not convert.`
            : "The conversion action setup could not be read, so it is not known whether tracking is configured."),
        recommendation:
          "Check each primary conversion action's status and recent activity in Google Ads (Goals > Conversions), test the tag with Tag Assistant, and compare with conversions recorded in the website or app analytics for the same period.",
        observed: setup.status === "ok" ? { ...observed, primary_conversion_actions: setup.primary } : observed,
        thresholds,
        source: setup.status === "ok" ? `daily metrics and ${diagnosticsSource(ctx)}` : "daily metrics",
        unavailable: [...unavailable, ...(setup.status === "ok" ? diagnosticsCaveat(ctx) : [`conversion action setup (${setup.reason})`]), "conversion tag diagnostics"],
        estimatedImpact: round(spend),
        estimateLabel: "Spend without recorded conversions",
      }];
    }

    if (clicks < THRESHOLDS.minClicksForZeroConversions) return [];
    const pixel = metaPixelSetup(ctx);
    const pixelText = pixel.status !== "ok"
      ? "Pixel activity could not be read."
      : pixel.pixels === 0
      ? "No Meta pixel is connected to the ad account."
      : `${pixel.pixels} pixel(s) found; last activity ${pixel.lastFired ? pixel.lastFired.slice(0, 10) : "not reported"}.`;
    const pixelStale = pixel.status === "ok" && (pixel.pixels === 0 || !pixel.lastFired || pixel.lastFired.slice(0, 10) < ctx.period.start);
    return [{
      ruleId: "tracking.no_conversions",
      category: "tracking",
      severity: pixelStale ? "critical" : "high",
      basis: pixelStale ? "verified" : "indicative",
      title: pixelStale ? `Meta pixel shows no activity for ${ctx.account.name}` : `No conversions recorded for ${ctx.account.name}`,
      description:
        `${money(ctx, spend)} and ${formatNumber(clicks)} clicks on conversion-focused campaigns produced 0 purchases, leads or registrations. ${pixelText}` +
        (pixelStale ? "" : " Zero conversions alone does not prove that tracking is broken."),
      recommendation:
        "In Events Manager, confirm the pixel and Conversions API receive the optimization event, check event match quality and deduplication, and compare with conversions in the website analytics for the same period.",
      observed: pixel.status === "ok" ? { ...observed, pixels: pixel.pixels, pixel_last_fired: pixel.lastFired ? pixel.lastFired.slice(0, 10) : null } : observed,
      thresholds,
      source: pixel.status === "ok" ? `daily metrics and ${diagnosticsSource(ctx)}` : "daily metrics",
      unavailable: [...unavailable, ...(pixel.status === "ok" ? [] : [`pixel activity (${pixel.reason})`]), "Conversions API event diagnostics"],
      estimatedImpact: round(spend),
      estimateLabel: "Spend without recorded conversions",
    }];
  },
};

const missingConversionValue: Rule = {
  id: "tracking.no_conversion_value",
  category: "tracking",
  applies(ctx) {
    const sales = ctx.campaigns.filter((campaign) => expectsRevenue(goalOf(ctx, campaign)));
    if (sales.length === 0) return "no sales-focused campaigns (lead, app and awareness campaigns need no monetary value)";
    const conversions = sales.reduce((sum, campaign) => sum + campaign.conversions, 0);
    return conversions >= THRESHOLDS.minConversionsForValueCheck ? null : `fewer than ${THRESHOLDS.minConversionsForValueCheck} conversions on sales-focused campaigns`;
  },
  run(ctx) {
    const sales = ctx.campaigns.filter((campaign) => expectsRevenue(goalOf(ctx, campaign)));
    const conversions = sales.reduce((sum, campaign) => sum + campaign.conversions, 0);
    const value = sales.reduce((sum, campaign) => sum + campaign.conversionValue, 0);
    if (value > 0) return [];
    return [{
      ruleId: "tracking.no_conversion_value",
      category: "tracking",
      severity: "medium",
      basis: "verified",
      title: "Sales campaigns report conversions without value",
      description:
        `${sales.length} sales-focused campaign(s) (value bidding, Shopping or a sales objective) recorded ${formatNumber(conversions, 0)} conversions with no conversion value, ` +
        "so return on ad spend cannot be measured.",
      recommendation:
        "Send the transaction value and currency with each purchase conversion (or set a default value on the conversion action) so ROAS reporting and value-based bidding work.",
      observed: { sales_campaigns: sales.length, conversions: round(conversions), conversion_value: 0 },
      thresholds: { min_conversions: THRESHOLDS.minConversionsForValueCheck },
      unavailable: [],
    }];
  },
};

const leadCounting: Rule = {
  id: "tracking.lead_counting",
  category: "tracking",
  applies(ctx) {
    if (ctx.account.provider !== "google") return "Google Ads only";
    return googleConversionSetup(ctx).status === "ok" ? null : "conversion actions were not captured";
  },
  run(ctx) {
    const setup = googleConversionSetup(ctx);
    if (setup.status !== "ok" || setup.leadManyPerClick.length === 0) return [];
    return [{
      ruleId: "tracking.lead_counting",
      category: "tracking",
      severity: "low",
      basis: "verified",
      title: "Lead conversions count every conversion per click",
      description:
        `${setup.leadManyPerClick.length} primary lead conversion action(s) use "every" counting (${setup.leadManyPerClick.slice(0, 3).join(", ")}). ` +
        "Repeat submissions by the same person are then counted as separate leads, which can overstate results and understate cost per lead.",
      recommendation: "Unless repeat leads are valuable to the business, switch these conversion actions to count one conversion per click.",
      observed: { lead_actions_counting_every: setup.leadManyPerClick.length },
      thresholds: { expected_counting: "ONE_PER_CLICK for leads" },
      source: diagnosticsSource(ctx),
      unavailable: [],
    }];
  },
};

// ---------------------------------------------------------------------------
// Efficiency
// ---------------------------------------------------------------------------

const spendWithoutConversions: Rule = {
  id: "efficiency.spend_without_conversions",
  category: "efficiency",
  applies(ctx) {
    const relevant = conversionCampaigns(ctx);
    const conversions = relevant.reduce((sum, campaign) => sum + campaign.conversions, 0);
    if (conversions <= 0) return "the account recorded no conversions (covered by the tracking check)";
    const clicks = relevant.reduce((sum, campaign) => sum + campaign.clicks, 0);
    return clicks >= THRESHOLDS.minClicksForZeroConversions ? null : `fewer than ${THRESHOLDS.minClicksForZeroConversions} clicks on conversion-focused campaigns`;
  },
  run(ctx) {
    const total = ctx.kpis.spend;
    if (total <= 0) return [];
    return conversionCampaigns(ctx)
      .filter((campaign) => campaign.spend >= total * THRESHOLDS.minCampaignSpendShare && campaign.conversions === 0 && campaign.clicks >= THRESHOLDS.minCampaignClicksForZeroConversions)
      .map((campaign) => ({
        ruleId: "efficiency.spend_without_conversions",
        category: "efficiency" as const,
        severity: "high" as const,
        basis: "verified" as const,
        campaign,
        scoringGroup: "efficiency.campaign_return",
        title: `"${campaign.name}" spent without converting`,
        description:
          `${money(ctx, campaign.spend)} (${formatPercent(campaign.spend / total, 1)} of account spend) produced ${formatNumber(campaign.clicks)} clicks and 0 conversions, ` +
          "while other campaigns in the account did record conversions.",
        recommendation:
          "Review this campaign's targeting, search terms or audiences, landing page and optimization goal before deciding whether to reduce or reallocate its budget.",
        observed: { spend: round(campaign.spend), spend_share: round(campaign.spend / total, 3), clicks: campaign.clicks, conversions: 0 },
        thresholds: { min_spend_share: THRESHOLDS.minCampaignSpendShare, min_clicks: THRESHOLDS.minCampaignClicksForZeroConversions },
        unavailable: [],
        estimatedImpact: round(campaign.spend),
        estimateLabel: "Spend without recorded conversions",
      }));
  },
};

const highCpaCampaign: Rule = {
  id: "efficiency.high_cpa_campaign",
  category: "efficiency",
  applies(ctx) {
    if (ctx.target?.targetCpa) return null;
    return ctx.kpis.conversions >= THRESHOLDS.minAccountConversionsForCpa ? null : `fewer than ${THRESHOLDS.minAccountConversionsForCpa} account conversions`;
  },
  run(ctx) {
    const targetCpa = ctx.target?.targetCpa ?? null;
    const reference = targetCpa ?? ctx.kpis.cpa;
    if (reference === null || reference <= 0) return [];
    return conversionCampaigns(ctx).flatMap((campaign): Draft[] => {
      if (campaign.conversions < THRESHOLDS.minConversionsForCpa || campaign.spend < ctx.kpis.spend * 0.05) return [];
      const cpa = campaign.spend / campaign.conversions;
      if (cpa < reference * THRESHOLDS.cpaOutlierMultiple) return [];
      const excess = campaign.spend - campaign.conversions * reference;
      const kind = KIND_LABEL[campaignKind(campaign)] ?? "Other";
      return [{
        ruleId: "efficiency.high_cpa_campaign",
        category: "efficiency" as const,
        severity: (cpa >= reference * THRESHOLDS.cpaSevereMultiple ? "high" : "medium") as Severity,
        basis: (targetCpa ? "target" : "indicative") as FindingBasis,
        campaign,
        scoringGroup: "efficiency.campaign_return",
        title: `"${campaign.name}" costs ${formatMultiple(cpa / reference, 1)} the ${targetCpa ? "target" : "account average"} per conversion`,
        description:
          `Cost per conversion is ${money(ctx, cpa)} across ${formatNumber(campaign.conversions, 0)} conversions, against ${targetCpa ? "a target CPA" : "an account average"} of ${money(ctx, reference)}. ` +
          (targetCpa ? "" : `Campaign types differ in what a conversion means (this is a ${kind} campaign), so compare like with like before acting.`),
        recommendation:
          "Check whether this campaign's conversions are the same kind as the rest of the account's; if they are, tighten targeting or creative and test moving budget toward campaigns at or below the reference CPA.",
        observed: { campaign_cpa: round(cpa), conversions: round(campaign.conversions), spend: round(campaign.spend) },
        thresholds: { reference_cpa: round(reference), multiple: THRESHOLDS.cpaOutlierMultiple },
        reference: targetCpa ? "business target CPA supplied by PRISIM" : undefined,
        unavailable: [],
        estimatedImpact: round(Math.max(excess, 0)),
        estimateLabel: "Spend above the reference CPA (estimate)",
      }];
    });
  },
};

const lowRoasCampaign: Rule = {
  id: "efficiency.low_roas_campaign",
  category: "efficiency",
  applies(ctx) {
    const sales = ctx.campaigns.filter((campaign) => expectsRevenue(goalOf(ctx, campaign)) && campaign.conversionValue > 0);
    return sales.length > 0 ? null : "no sales-focused campaigns that report conversion value";
  },
  run(ctx) {
    const targetRoas = ctx.target?.targetRoas ?? null;
    const floor = targetRoas ?? 1;
    return ctx.campaigns.flatMap((campaign): Draft[] => {
      if (!expectsRevenue(goalOf(ctx, campaign)) || campaign.conversionValue <= 0) return [];
      if (campaign.spend < ctx.kpis.spend * 0.05 || campaign.conversions < THRESHOLDS.minConversionsForCpa) return [];
      const roas = campaign.conversionValue / campaign.spend;
      if (roas >= floor) return [];
      return [{
        ruleId: "efficiency.low_roas_campaign",
        category: "efficiency" as const,
        severity: (roas < 1 ? "high" : "medium") as Severity,
        basis: (targetRoas ? "target" : "verified") as FindingBasis,
        campaign,
        scoringGroup: "efficiency.campaign_return",
        title: `"${campaign.name}" returns ${formatMultiple(roas)} on ad spend`,
        description:
          `${money(ctx, campaign.conversionValue)} of reported conversion value from ${money(ctx, campaign.spend)} of spend` +
          (targetRoas ? `, below the target ROAS of ${formatMultiple(targetRoas)}.` : ", so reported value is below spend.") +
          " Reported value is platform-attributed revenue, not profit.",
        recommendation:
          "Confirm the reported value matches actual revenue, then set or lower a target ROAS and exclude low-value products or audiences.",
        observed: { roas: round(roas, 2), spend: round(campaign.spend), conversion_value: round(campaign.conversionValue) },
        thresholds: { roas_floor: floor },
        reference: targetRoas ? "business target ROAS supplied by PRISIM" : undefined,
        unavailable: ["product margins"],
        estimatedImpact: round(Math.max(campaign.spend - campaign.conversionValue, 0)),
        estimateLabel: "Spend above reported value (estimate, not a loss)",
      }];
    });
  },
};

const accountRoas: Rule = {
  id: "efficiency.account_roas",
  category: "efficiency",
  applies(ctx) {
    return ctx.kpis.conversionValue > 0 && ctx.kpis.spend > 0 ? null : "no conversion value reported";
  },
  run(ctx) {
    const { roas, conversionValue, spend } = ctx.kpis;
    const targetRoas = ctx.target?.targetRoas ?? null;
    if (roas === null) return [];
    // Without a target, only a ROAS below 1 (reported value below spend) is a finding:
    // a "good" ROAS depends on the business's margins, which are not known.
    const floor = targetRoas ?? 1;
    if (roas >= floor) return [];
    return [{
      ruleId: "efficiency.account_roas",
      category: "efficiency",
      severity: roas < 1 ? "high" : "medium",
      basis: targetRoas ? "target" : "verified",
      scoringGroup: "efficiency.account_return",
      title: `Account return on ad spend is ${formatMultiple(roas)}`,
      description:
        `${ctx.account.name} reported ${money(ctx, conversionValue)} of conversion value from ${money(ctx, spend)} of spend` +
        (targetRoas ? `, below the target ROAS of ${formatMultiple(targetRoas)}.` : ".") +
        " Reported value is attributed by the platform and may include conversions that would have happened anyway.",
      recommendation: "Agree a margin-based ROAS target with the business, prioritize the highest-return campaigns and confirm the value tracking reflects real revenue.",
      observed: { roas: round(roas, 2), spend: round(spend), conversion_value: round(conversionValue) },
      thresholds: { roas_floor: floor },
      reference: targetRoas ? "business target ROAS supplied by PRISIM" : undefined,
      unavailable: targetRoas ? [] : ["business ROAS target", "product margins"],
    }];
  },
};

const wastedSearchTerms: Rule = {
  id: "efficiency.search_terms",
  category: "efficiency",
  applies(ctx) {
    if (ctx.account.provider !== "google") return "Google Ads only";
    if (!ctx.campaigns.some((campaign) => ["search", "shopping"].includes(campaignKind(campaign)) && delivered(campaign))) return "no Search or Shopping campaigns with delivery";
    const section = diagnosticsSection(ctx, "search_terms");
    return section?.status === "ok" ? null : "search terms were not captured";
  },
  run(ctx) {
    const section = diagnosticsSection(ctx, "search_terms");
    if (section?.status !== "ok") return [];
    const rows = section.rows.map((row) => ({
      term: String(row.search_term ?? ""),
      status: String(row.status ?? ""),
      clicks: Number(row.clicks ?? 0),
      cost: Number(row.cost ?? 0),
      conversions: Number(row.conversions ?? 0),
    }));
    const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);
    const candidates = rows.filter((row) => row.conversions === 0 && row.clicks >= THRESHOLDS.searchTermMinClicks && row.status !== "EXCLUDED" && row.status !== "ADDED_EXCLUDED");
    const cost = candidates.reduce((sum, row) => sum + row.cost, 0);
    if (totalCost <= 0 || candidates.length < 3 || cost / totalCost < THRESHOLDS.searchTermCostShare) return [];
    const share = cost / totalCost;
    return [{
      ruleId: "efficiency.search_terms",
      category: "efficiency",
      severity: share >= 0.25 ? "medium" : "low",
      basis: "indicative",
      scoringGroup: "efficiency.search_terms",
      title: `${candidates.length} search terms took ${formatPercent(share, 0)} of search-term spend without converting`,
      description:
        `Top examples: ${candidates.slice(0, 5).map((row) => `"${row.term}" (${money(ctx, row.cost)}, ${row.clicks} clicks)`).join(", ")}. ` +
        "Whether these queries are irrelevant needs human review; some may convert later or assist other conversions." +
        (section.truncated ? " Only the highest-cost search terms were read." : ""),
      recommendation: "Review the listed queries and add the irrelevant ones as negative keywords; keep relevant non-converting queries under observation.",
      observed: { candidate_terms: candidates.length, candidate_cost: round(cost), search_term_cost: round(totalCost), cost_share: round(share, 3) },
      thresholds: { min_clicks: THRESHOLDS.searchTermMinClicks, min_cost_share: THRESHOLDS.searchTermCostShare },
      source: diagnosticsSource(ctx),
      unavailable: ["Performance Max search terms (not in search_term_view)", ...diagnosticsCaveat(ctx)],
      estimatedImpact: round(cost),
      estimateLabel: "Spend on non-converting search terms (to review)",
    }];
  },
};

// ---------------------------------------------------------------------------
// Engagement and creative
// ---------------------------------------------------------------------------

function ctrPeers(ctx: RuleContext, campaign: AuditCampaign) {
  const kind = campaignKind(campaign);
  return ctx.campaigns.filter((other) => other.id !== campaign.id && campaignKind(other) === kind && other.impressions >= THRESHOLDS.minImpressionsForCtr);
}

function ctrEligible(ctx: RuleContext, campaign: AuditCampaign) {
  const goal = goalOf(ctx, campaign);
  const kind = campaignKind(campaign);
  return campaign.impressions >= THRESHOLDS.minImpressionsForCtr && goal !== "awareness" && kind !== "video";
}

function benchmarkFor(ctx: RuleContext, campaign: AuditCampaign) {
  const kind = campaignKind(campaign);
  return ctx.benchmarks.find((item) => item.metric === "ctr" && item.provider === campaign.provider && item.kind === kind) ?? null;
}

const lowCtr: Rule = {
  id: "engagement.low_ctr",
  category: "engagement",
  applies(ctx) {
    const ok = ctx.campaigns.some((campaign) => ctrEligible(ctx, campaign) && (benchmarkFor(ctx, campaign) || ctrPeers(ctx, campaign).length >= THRESHOLDS.minPeersForCtr));
    return ok ? null : "no campaign with enough impressions and a comparable peer group or sourced benchmark";
  },
  run(ctx) {
    return ctx.campaigns.flatMap((campaign): Draft[] => {
      if (!ctrEligible(ctx, campaign)) return [];
      const ctr = campaign.clicks / campaign.impressions;
      const benchmark = benchmarkFor(ctx, campaign);
      const kind = KIND_LABEL[campaignKind(campaign)] ?? "Other";
      if (benchmark) {
        if (ctr >= benchmark.value) return [];
        return [{
          ruleId: "engagement.low_ctr",
          category: "engagement" as const,
          severity: (ctr < benchmark.value * 0.5 ? "medium" : "low") as Severity,
          basis: "benchmark" as const,
          campaign,
          scoringGroup: "engagement.relevance",
          title: `"${campaign.name}" click-through rate is below the ${kind} benchmark`,
          description: `CTR is ${formatPercent(ctr)} on ${formatNumber(campaign.impressions)} impressions against a benchmark of ${formatPercent(benchmark.value)} (${benchmark.source}; ${benchmark.applicability}). Benchmarks are indicative, not targets.`,
          recommendation: "Test new ad copy or creative that matches the audience's intent, and check targeting relevance.",
          observed: { ctr: round(ctr * 100, 3), impressions: campaign.impressions, clicks: campaign.clicks },
          thresholds: { benchmark_ctr: round(benchmark.value * 100, 3) },
          reference: `${benchmark.source} (${benchmark.applicability})`,
          unavailable: [],
        }];
      }
      const peers = ctrPeers(ctx, campaign);
      if (peers.length < THRESHOLDS.minPeersForCtr) return [];
      const peerCtr = median(peers.map((peer) => peer.clicks / peer.impressions));
      if (peerCtr === null || ctr >= peerCtr * THRESHOLDS.ctrPeerFraction) return [];
      return [{
        ruleId: "engagement.low_ctr",
        category: "engagement" as const,
        severity: (ctr < peerCtr / 3 ? "medium" : "low") as Severity,
        basis: "indicative" as const,
        campaign,
        scoringGroup: "engagement.relevance",
        title: `"${campaign.name}" click-through rate is well below similar campaigns`,
        description:
          `CTR is ${formatPercent(ctr)} on ${formatNumber(campaign.impressions)} impressions, against a median of ${formatPercent(peerCtr)} for ${peers.length} other ${kind} campaign(s) in this account. ` +
          "No external benchmark is applied.",
        recommendation:
          campaign.provider === "meta"
            ? "Test fresh creative and hooks, and check that the audience and placements match the offer."
            : "Check ad relevance: tighten keyword-to-ad grouping, add ad variations and assets, and review search terms.",
        observed: { ctr: round(ctr * 100, 3), impressions: campaign.impressions, clicks: campaign.clicks },
        thresholds: { peer_median_ctr: round(peerCtr * 100, 3), fraction_of_peer: THRESHOLDS.ctrPeerFraction, peers: peers.length },
        unavailable: ["sourced external CTR benchmark"],
      }];
    });
  },
};

const highFrequency: Rule = {
  id: "engagement.high_frequency",
  category: "engagement",
  applies(ctx) {
    if (ctx.account.provider !== "meta") return "Meta only";
    if (ctx.quality.unavailableFields.includes("reach")) return "reach was not returned by Meta";
    return ctx.campaigns.some((campaign) => campaign.impressions >= THRESHOLDS.minImpressionsForFrequency && campaign.reach > 0) ? null : "no campaign with enough impressions and reach";
  },
  run(ctx) {
    return ctx.campaigns.flatMap((campaign): Draft[] => {
      if (campaign.impressions < THRESHOLDS.minImpressionsForFrequency || campaign.reach <= 0) return [];
      // Reach is stored per day, so impressions / summed daily reach is the
      // average DAILY frequency; unique reach for the period is not available.
      const frequency = campaign.impressions / campaign.reach;
      if (frequency < THRESHOLDS.frequencyHigh) return [];
      return [{
        ruleId: "engagement.high_frequency",
        category: "engagement" as const,
        severity: (frequency >= THRESHOLDS.frequencySevere ? "high" : "medium") as Severity,
        basis: "indicative" as const,
        campaign,
        scoringGroup: "engagement.fatigue",
        title: `"${campaign.name}" shows signs of ad fatigue`,
        description:
          `People who saw the ads saw them ${formatNumber(frequency, 1)} times per day on average. High repeated exposure often lowers CTR and raises cost per result; check whether CTR declined over the period.`,
        recommendation: "Rotate in new creative, broaden the audience or use frequency caps on awareness campaigns.",
        observed: { average_daily_frequency: round(frequency, 2), impressions: campaign.impressions, summed_daily_reach: campaign.reach },
        thresholds: { frequency_high: THRESHOLDS.frequencyHigh, frequency_severe: THRESHOLDS.frequencySevere },
        unavailable: ["unique reach for the whole period"],
      }];
    });
  },
};

const lowConversionRate: Rule = {
  id: "engagement.low_conversion_rate",
  category: "engagement",
  applies(ctx) {
    const eligible = conversionCampaigns(ctx).filter((campaign) => campaign.clicks >= THRESHOLDS.minClicksForConversionRate && campaign.conversions > 0);
    return eligible.length >= 3 ? null : "fewer than three converting campaigns with enough clicks to compare";
  },
  run(ctx) {
    const eligible = conversionCampaigns(ctx).filter((campaign) => campaign.clicks >= THRESHOLDS.minClicksForConversionRate);
    return eligible.flatMap((campaign): Draft[] => {
      const kind = campaignKind(campaign);
      const peers = eligible.filter((other) => other.id !== campaign.id && campaignKind(other) === kind && other.conversions > 0);
      if (peers.length < 2) return [];
      const rate = campaign.conversions / campaign.clicks;
      const peerRate = median(peers.map((peer) => peer.conversions / peer.clicks));
      if (peerRate === null || rate >= peerRate * THRESHOLDS.conversionRatePeerFraction) return [];
      return [{
        ruleId: "engagement.low_conversion_rate",
        category: "engagement" as const,
        severity: "low" as const,
        basis: "indicative" as const,
        campaign,
        scoringGroup: "engagement.relevance",
        title: `"${campaign.name}" converts far fewer clicks than similar campaigns`,
        description: `${formatPercent(rate)} of ${formatNumber(campaign.clicks)} clicks converted, against a median of ${formatPercent(peerRate)} for ${peers.length} similar campaign(s).`,
        recommendation: "Compare the landing page, offer and audience intent with the better-converting campaigns.",
        observed: { conversion_rate: round(rate * 100, 2), clicks: campaign.clicks, conversions: round(campaign.conversions) },
        thresholds: { peer_median_conversion_rate: round(peerRate * 100, 2), fraction_of_peer: THRESHOLDS.conversionRatePeerFraction },
        unavailable: [],
      }];
    });
  },
};

const adReview: Rule = {
  id: "engagement.ad_review",
  category: "engagement",
  applies(ctx) {
    const section = diagnosticsSection(ctx, "ads");
    return section?.status === "ok" ? null : "ad review status was not captured";
  },
  run(ctx) {
    const section = diagnosticsSection(ctx, "ads");
    if (section?.status !== "ok") return [];
    const byCampaign = new Map<string, { enabled: number; disapproved: number; limited: number; issues: number }>();
    for (const row of section.rows) {
      const id = String(row.campaign_id ?? "");
      const entry = byCampaign.get(id) ?? { enabled: 0, disapproved: 0, limited: 0, issues: 0 };
      if (ctx.account.provider === "google") {
        if (row.status !== "ENABLED") continue;
        entry.enabled += 1;
        if (row.approval_status === "DISAPPROVED") entry.disapproved += 1;
        if (row.approval_status === "APPROVED_LIMITED") entry.limited += 1;
      } else {
        const status = String(row.effective_status ?? "");
        if (["PAUSED", "DELETED", "ARCHIVED", "CAMPAIGN_PAUSED", "ADSET_PAUSED"].includes(status)) continue;
        entry.enabled += 1;
        if (status === "DISAPPROVED") entry.disapproved += 1;
        if (status === "WITH_ISSUES") entry.issues += 1;
      }
      byCampaign.set(id, entry);
    }
    return ctx.campaigns.flatMap((campaign): Draft[] => {
      if (!isEnabled(campaign) || !campaign.externalId) return [];
      const entry = byCampaign.get(campaign.externalId);
      if (!entry || entry.enabled === 0 || entry.disapproved + entry.issues === 0) return [];
      const share = (entry.disapproved + entry.issues) / entry.enabled;
      return [{
        ruleId: "engagement.ad_review",
        category: "engagement" as const,
        severity: (share >= 1 ? "high" : share >= 0.25 ? "medium" : "low") as Severity,
        basis: "verified" as const,
        campaign,
        scoringGroup: "engagement.ad_review",
        title: `${entry.disapproved + entry.issues} of ${entry.enabled} active ads in "${campaign.name}" are disapproved or have issues`,
        description:
          `At capture time: ${entry.disapproved} disapproved, ${entry.issues} with delivery issues${entry.limited ? `, ${entry.limited} approved with limitations` : ""}. ` +
          "Disapproved ads do not serve; this status may have changed since capture.",
        recommendation: "Open the policy details for each disapproved ad, fix the cited issue or appeal, and replace ads that cannot be approved.",
        observed: { active_ads: entry.enabled, disapproved: entry.disapproved, with_issues: entry.issues, approved_limited: entry.limited },
        thresholds: { any_disapproved: true },
        source: diagnosticsSource(ctx),
        unavailable: ["ad status history during the period", ...diagnosticsCaveat(ctx)],
      }];
    });
  },
};

const adStrength: Rule = {
  id: "engagement.ad_strength",
  category: "engagement",
  applies(ctx) {
    if (ctx.account.provider !== "google") return "Google Ads only";
    const section = diagnosticsSection(ctx, "ads");
    if (section?.status !== "ok") return "ads were not captured";
    return section.rows.some((row) => row.ad_type === "RESPONSIVE_SEARCH_AD") ? null : "no responsive search ads";
  },
  run(ctx) {
    const section = diagnosticsSection(ctx, "ads");
    if (section?.status !== "ok") return [];
    const rsa = section.rows.filter((row) => row.ad_type === "RESPONSIVE_SEARCH_AD" && row.status === "ENABLED");
    const rated = rsa.filter((row) => ["POOR", "AVERAGE", "GOOD", "EXCELLENT"].includes(String(row.ad_strength)));
    const poor = rated.filter((row) => row.ad_strength === "POOR");
    if (rated.length === 0 || poor.length / rated.length < 0.25) return [];
    return [{
      ruleId: "engagement.ad_strength",
      category: "engagement",
      severity: "low",
      basis: "verified",
      scoringGroup: "engagement.creative",
      title: `${poor.length} of ${rated.length} responsive search ads have Poor ad strength`,
      description: "Ad strength is Google's rating of headline and description variety and relevance. Poor-rated ads have few or repetitive assets, which limits the combinations Google can test. Ad strength is a guide, not a ranking factor by itself.",
      recommendation: "Add distinct headlines and descriptions that include the main keywords, and avoid pinning assets unless required.",
      observed: { rated_ads: rated.length, poor_ads: poor.length },
      thresholds: { poor_share: 0.25 },
      source: diagnosticsSource(ctx),
      unavailable: diagnosticsCaveat(ctx),
    }];
  },
};

const qualityScore: Rule = {
  id: "engagement.quality_score",
  category: "engagement",
  applies(ctx) {
    if (ctx.account.provider !== "google") return "Google Ads only";
    const section = diagnosticsSection(ctx, "keywords");
    if (section?.status !== "ok") return "keyword Quality Score was not captured";
    return section.rows.some((row) => typeof row.quality_score === "number" && Number(row.cost ?? 0) > 0) ? null : "no keywords with spend and a Quality Score";
  },
  run(ctx) {
    const section = diagnosticsSection(ctx, "keywords");
    if (section?.status !== "ok") return [];
    const rows = section.rows.filter((row) => typeof row.quality_score === "number" && Number(row.cost ?? 0) > 0);
    const total = rows.reduce((sum, row) => sum + Number(row.cost), 0);
    const low = rows.filter((row) => Number(row.quality_score) <= THRESHOLDS.lowQualityScore);
    const lowCost = low.reduce((sum, row) => sum + Number(row.cost), 0);
    if (total <= 0 || lowCost / total < THRESHOLDS.lowQualityCostShare) return [];
    const components = ["expected_ctr", "creative_quality", "landing_page_quality"].map((field) => [field, low.filter((row) => row[field] === "BELOW_AVERAGE").length] as const);
    const worst = [...components].sort((a, b) => b[1] - a[1])[0];
    const labels: Record<string, string> = { expected_ctr: "expected CTR", creative_quality: "ad relevance", landing_page_quality: "landing page experience" };
    const share = lowCost / total;
    return [{
      ruleId: "engagement.quality_score",
      category: "engagement",
      severity: share >= 0.25 ? "medium" : "low",
      basis: "verified",
      scoringGroup: "engagement.relevance_keywords",
      title: `${formatPercent(share, 0)} of keyword spend is on keywords with Quality Score ${THRESHOLDS.lowQualityScore} or lower`,
      description:
        `${low.length} keyword(s) with a Quality Score of ${THRESHOLDS.lowQualityScore} or lower account for ${money(ctx, lowCost)} of ${money(ctx, total)} keyword spend. ` +
        (worst && worst[1] > 0 ? `The most common below-average component is ${labels[worst[0]]} (${worst[1]} keywords).` : ""),
      recommendation: "Improve the weakest component: tighter ad groups and ad copy for expected CTR and ad relevance, faster and more relevant pages for landing page experience.",
      observed: { low_qs_keywords: low.length, low_qs_cost: round(lowCost), keyword_cost: round(total), ...Object.fromEntries(components.map(([field, count]) => [`below_average_${field}`, count])) },
      thresholds: { quality_score_at_most: THRESHOLDS.lowQualityScore, min_cost_share: THRESHOLDS.lowQualityCostShare },
      source: diagnosticsSource(ctx),
      unavailable: [...(section.truncated ? ["keywords beyond the 300 highest-cost"] : []), ...diagnosticsCaveat(ctx)],
    }];
  },
};

function impressionShareRows(ctx: RuleContext) {
  const section = diagnosticsSection(ctx, "search_impression_share");
  if (section?.status !== "ok") return null;
  return section.rows.filter((row) => Number(row.impressions ?? 0) >= THRESHOLDS.minImpressionsForImpressionShare);
}

const rankLostShare: Rule = {
  id: "engagement.rank_lost_impression_share",
  category: "engagement",
  applies(ctx) {
    if (ctx.account.provider !== "google") return "Google Ads only";
    const rows = impressionShareRows(ctx);
    return rows && rows.length > 0 ? null : "Search impression share was not captured or no Search campaign had enough impressions";
  },
  run(ctx) {
    const rows = impressionShareRows(ctx) ?? [];
    return rows.flatMap((row): Draft[] => {
      const lost = typeof row.search_rank_lost_impression_share === "number" ? row.search_rank_lost_impression_share : null;
      const campaign = ctx.campaigns.find((item) => item.externalId === row.campaign_id);
      if (lost === null || !campaign || lost < THRESHOLDS.rankLostShare) return [];
      return [{
        ruleId: "engagement.rank_lost_impression_share",
        category: "engagement" as const,
        severity: "low" as const,
        basis: "verified" as const,
        campaign,
        scoringGroup: "engagement.relevance",
        title: `"${campaign.name}" lost ${formatPercent(lost, 0)} of Search impressions to ad rank`,
        description: "Lost impression share (rank) is the share of eligible impressions missed because of low ad rank (bids, quality and ad assets).",
        recommendation: "Improve Quality Score components and ad assets before raising bids; check whether the missed auctions are valuable.",
        observed: { rank_lost_impression_share: round(lost, 3), search_impression_share: typeof row.search_impression_share === "number" ? round(row.search_impression_share, 3) : null },
        thresholds: { rank_lost_share: THRESHOLDS.rankLostShare },
        source: diagnosticsSource(ctx),
        unavailable: diagnosticsCaveat(ctx),
      }];
    });
  },
};

// ---------------------------------------------------------------------------
// Structure and delivery
// ---------------------------------------------------------------------------

const noDelivery: Rule = {
  id: "structure.no_delivery",
  category: "structure",
  applies(ctx) {
    const enabled = ctx.campaigns.filter(isEnabled);
    if (enabled.length === 0) return "no enabled campaigns";
    return enabled.some((campaign) => eligibleDays(ctx, campaign).known >= THRESHOLDS.minEligibleDays) ? null : `fewer than ${THRESHOLDS.minEligibleDays} known days for enabled campaigns`;
  },
  run(ctx) {
    return ctx.campaigns.flatMap((campaign): Draft[] => {
      if (!isEnabled(campaign) || delivered(campaign)) return [];
      const days = eligibleDays(ctx, campaign);
      if (days.notStarted || days.endedBefore) return [];
      if (days.known < THRESHOLDS.minEligibleDays) return [];
      // Verified only when the days were retrieved by a successful sync (so no
      // rows means no delivery) and the campaign's schedule is known.
      const verified = days.retrieved >= THRESHOLDS.minEligibleDays && days.scheduleKnown;
      const reasons = primaryReasons(campaign);
      const unavailable = ["campaign status history during the period"];
      if (!days.scheduleKnown) unavailable.push("campaign start and end dates");
      if (!campaign.details?.primaryStatus && campaign.provider === "google") unavailable.push("campaign primary status");
      if (days.retrieved < days.known) unavailable.push(`sync confirmation for ${days.known - days.retrieved} day(s) with account data`);
      const scheduleText = days.scheduleKnown
        ? `It is scheduled from ${days.start}${days.end ? ` to ${days.end}` : ""}, so ${days.known} known day(s) of the period were eligible.`
        : "Its start date is not known, so it may not have existed for the whole period.";
      return [{
        ruleId: "structure.no_delivery",
        category: "structure" as const,
        severity: (verified && days.retrieved >= 14 ? "high" : "medium") as Severity,
        basis: (verified ? "verified" : "indicative") as FindingBasis,
        campaign,
        scoringGroup: "structure.delivery",
        title: `"${campaign.name}" is enabled but delivered no impressions`,
        description:
          `No impressions or spend were recorded for this campaign on ${days.known} known day(s) of the period (${days.retrieved} confirmed by a successful sync). Its status is ${statusNote(campaign)}. ${scheduleText}` +
          (reasons ? ` Google reports: ${campaign.details?.primaryStatus ?? ""} (${reasons}).` : " The reason is not reported in the synced data."),
        recommendation:
          campaign.provider === "google"
            ? "Open the campaign in Google Ads and review its status column and policy, billing, targeting, bid and budget details; if it is no longer needed, pause it."
            : "Check the campaign's delivery column in Ads Manager for ad set or ad issues, billing, audience size and schedule; pause it if it is no longer needed.",
        observed: {
          impressions: 0,
          spend: 0,
          known_days: days.known,
          retrieved_days: days.retrieved,
          status_at_sync: campaign.status,
          primary_status: campaign.details?.primaryStatus ?? null,
          primary_status_reasons: reasons,
          start: days.start,
          end: days.end,
          daily_budget: campaign.dailyBudget,
        },
        thresholds: { min_known_days: THRESHOLDS.minEligibleDays },
        unavailable,
      }];
    });
  },
};

const fragmentation: Rule = {
  id: "structure.fragmentation",
  category: "structure",
  applies(ctx) {
    return ctx.campaigns.filter((campaign) => campaign.spend > 0).length >= THRESHOLDS.fragmentationMinCampaigns ? null : `fewer than ${THRESHOLDS.fragmentationMinCampaigns} spending campaigns`;
  },
  run(ctx) {
    const spending = ctx.campaigns.filter((campaign) => campaign.spend > 0);
    if (ctx.kpis.spend <= 0) return [];
    const tiny = spending.filter((campaign) => campaign.spend / ctx.kpis.spend < THRESHOLDS.fragmentationSmallShare);
    if (tiny.length < spending.length / 2) return [];
    return [{
      ruleId: "structure.fragmentation",
      category: "structure",
      severity: "medium",
      basis: "indicative",
      title: "Budget is spread across many small campaigns",
      description:
        `${tiny.length} of ${spending.length} spending campaigns each received less than ${formatPercent(THRESHOLDS.fragmentationSmallShare, 0)} of spend. ` +
        "Thin budgets give automated bidding little data per campaign. Separate campaigns can be intentional (regions, products, brand vs generic).",
      recommendation: "Consider consolidating campaigns that share a goal and audience so each has enough volume for automated bidding.",
      observed: { small_campaigns: tiny.length, campaigns_with_spend: spending.length },
      thresholds: { small_share: THRESHOLDS.fragmentationSmallShare, min_campaigns: THRESHOLDS.fragmentationMinCampaigns },
      unavailable: [],
    }];
  },
};

const learningLimited: Rule = {
  id: "structure.learning_limited",
  category: "structure",
  applies(ctx) {
    if (ctx.account.provider !== "meta") return "Meta only";
    const section = diagnosticsSection(ctx, "ad_sets");
    if (section?.status !== "ok") return "ad set learning status was not captured";
    return section.rows.some((row) => typeof row.learning_status === "string") ? null : "Meta returned no learning status (only for active, non-dynamic-creative ad sets)";
  },
  run(ctx) {
    const section = diagnosticsSection(ctx, "ad_sets");
    if (section?.status !== "ok") return [];
    return ctx.campaigns.flatMap((campaign): Draft[] => {
      if (!campaign.externalId || !delivered(campaign)) return [];
      const sets = section.rows.filter((row) => row.campaign_id === campaign.externalId && row.effective_status === "ACTIVE" && typeof row.learning_status === "string");
      const failed = sets.filter((row) => row.learning_status === "FAIL");
      if (failed.length === 0) return [];
      const goals = [...new Set(failed.map((row) => String(row.optimization_goal ?? "unknown")))];
      return [{
        ruleId: "structure.learning_limited",
        category: "structure" as const,
        severity: (failed.length === sets.length ? "medium" : "low") as Severity,
        basis: "verified" as const,
        campaign,
        scoringGroup: "structure.learning",
        title: `${failed.length} of ${sets.length} active ad sets in "${campaign.name}" are learning limited`,
        description:
          `Meta reports learning status FAIL (not generating enough optimization events to exit learning) for ad sets optimizing for ${goals.join(", ")}. ` +
          "The relevant event is the ad set's optimization goal, not necessarily the conversions shown in this audit.",
        recommendation: "Consolidate ad sets with the same goal, broaden audiences, or optimize for a more frequent event until volume is sufficient.",
        observed: { active_ad_sets_with_status: sets.length, learning_limited: failed.length, optimization_goals: goals.join(", ") },
        thresholds: { learning_status: "FAIL" },
        source: diagnosticsSource(ctx),
        unavailable: ["learning status history during the period", ...diagnosticsCaveat(ctx)],
      }];
    });
  },
};

const MANUAL_BIDDING = new Set(["MANUAL_CPC", "ENHANCED_CPC"]);

const manualBidding: Rule = {
  id: "structure.manual_bidding",
  category: "structure",
  applies(ctx) {
    return ctx.account.provider === "google" && ctx.campaigns.some((campaign) => MANUAL_BIDDING.has((campaign.bidStrategy ?? "").toUpperCase())) ? null : "no Google campaigns with manual CPC bidding";
  },
  run(ctx) {
    return ctx.campaigns.flatMap((campaign): Draft[] => {
      const strategy = (campaign.bidStrategy ?? "").toUpperCase();
      if (!MANUAL_BIDDING.has(strategy) || campaign.conversions < THRESHOLDS.manualBiddingMinConversions) return [];
      return [{
        ruleId: "structure.manual_bidding",
        category: "structure" as const,
        severity: "low" as const,
        basis: "indicative" as const,
        campaign,
        scoringGroup: "structure.bidding",
        title: `"${campaign.name}" uses manual bidding with enough conversions to test Smart Bidding`,
        description: `The campaign uses ${strategy.replace(/_/g, " ").toLowerCase()} and recorded ${formatNumber(campaign.conversions, 0)} conversions in the period. Manual bidding can be a deliberate choice.`,
        recommendation: "Test Maximize Conversions with a target CPA (or value with a target ROAS) as a campaign experiment against the current setup.",
        observed: { bid_strategy: strategy, conversions: round(campaign.conversions) },
        thresholds: { min_conversions: THRESHOLDS.manualBiddingMinConversions },
        unavailable: [],
      }];
    });
  },
};

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/** Current daily budget for a campaign or its shared budget; Meta ABO sums active ad set budgets. */
function campaignBudget(ctx: RuleContext, campaign: AuditCampaign): { amount: number; source: string } | null {
  if (campaign.dailyBudget && campaign.dailyBudget > 0) return { amount: campaign.dailyBudget, source: "campaign daily budget at last sync" };
  if (campaign.provider === "meta" && campaign.details?.budgetLevel === "ad_set" && campaign.externalId) {
    const section = diagnosticsSection(ctx, "ad_sets");
    if (section?.status === "ok") {
      const sets = section.rows.filter((row) => row.campaign_id === campaign.externalId && row.effective_status === "ACTIVE" && typeof row.daily_budget === "number");
      const total = sets.reduce((sum, row) => sum + Number(row.daily_budget), 0);
      if (total > 0) return { amount: total, source: `sum of ${sets.length} active ad set daily budgets at capture` };
    }
  }
  return null;
}

const underspend: Rule = {
  id: "budget.underspend",
  category: "budget",
  applies(ctx) {
    const ok = ctx.campaigns.some((campaign) => isEnabled(campaign) && delivered(campaign) && campaignBudget(ctx, campaign) && eligibleDays(ctx, campaign).known >= THRESHOLDS.minEligibleDays);
    return ok ? null : "no enabled, delivering campaign with a known daily budget";
  },
  run(ctx) {
    const drafts: Draft[] = [];
    const sharedDone = new Set<string>();
    for (const campaign of ctx.campaigns) {
      if (!isEnabled(campaign) || !delivered(campaign)) continue;
      const budget = campaignBudget(ctx, campaign);
      if (!budget) continue;
      const shared = campaign.details?.budgetShared === true && campaign.details.budgetId ? campaign.details.budgetId : null;
      if (shared && sharedDone.has(shared)) continue;
      const group = shared ? ctx.campaigns.filter((other) => other.details?.budgetId === shared) : [campaign];
      if (shared) sharedDone.add(shared);
      const days = eligibleDays(ctx, campaign);
      if (days.known < THRESHOLDS.minEligibleDays) continue;
      const spend = group.reduce((sum, item) => sum + item.spend, 0);
      const average = spend / days.known;
      if (average >= budget.amount * THRESHOLDS.underspendFraction) continue;
      const reasons = primaryReasons(campaign);
      const unavailable = ["budget changes during the period"];
      if (!days.scheduleKnown) unavailable.push("campaign start and end dates");
      drafts.push({
        ruleId: "budget.underspend",
        category: "budget",
        severity: "low",
        basis: "indicative",
        campaign,
        scoringGroup: "budget.utilization",
        title: shared ? `Shared budget used by ${group.length} campaigns spends well below its daily amount` : `"${campaign.name}" spends well below its daily budget`,
        description:
          `Average spend per known day was ${money(ctx, average)} over ${days.known} day(s), ${formatPercent(average / budget.amount, 0)} of the current daily budget of ${money(ctx, budget.amount)} (${budget.source}). ` +
          "The budget may have been changed during the period. The cause is not determined by this data" +
          (reasons ? `; Google reports ${reasons}.` : "; common causes include bid or target limits, narrow targeting, ad review status and low search volume."),
        recommendation: "Check the platform's delivery and status details for this campaign, and either address the limiting factor or lower the budget so the unused amount can be planned elsewhere.",
        observed: { average_daily_spend: round(average), daily_budget: round(budget.amount), known_days: days.known, campaigns_sharing_budget: group.length, primary_status_reasons: reasons },
        thresholds: { min_utilization: THRESHOLDS.underspendFraction },
        unavailable,
      });
    }
    return drafts;
  },
};

const budgetLostShare: Rule = {
  id: "budget.lost_impression_share",
  category: "budget",
  applies(ctx) {
    if (ctx.account.provider !== "google") return "Google Ads only";
    const rows = impressionShareRows(ctx);
    return rows && rows.length > 0 ? null : "Search impression share was not captured or no Search campaign had enough impressions";
  },
  run(ctx) {
    const rows = impressionShareRows(ctx) ?? [];
    const reference = ctx.target?.targetCpa ?? ctx.kpis.cpa;
    return rows.flatMap((row): Draft[] => {
      const lost = typeof row.search_budget_lost_impression_share === "number" ? row.search_budget_lost_impression_share : null;
      const campaign = ctx.campaigns.find((item) => item.externalId === row.campaign_id);
      if (lost === null || !campaign || lost < THRESHOLDS.budgetLostShare) return [];
      const cpa = ratio(campaign.spend, campaign.conversions);
      const efficient = cpa !== null && reference !== null && cpa <= reference;
      return [{
        ruleId: "budget.lost_impression_share",
        category: "budget" as const,
        severity: (efficient ? "medium" : "low") as Severity,
        basis: "verified" as const,
        campaign,
        scoringGroup: "budget.limited",
        title: `"${campaign.name}" lost ${lost >= 0.9 ? "over 90%" : formatPercent(lost, 0)} of Search impressions to budget`,
        description:
          `Google reports that the campaign missed this share of eligible impressions because the budget ran out. ` +
          (efficient ? `Its cost per conversion (${money(ctx, cpa)}) is at or below the reference of ${money(ctx, reference)}.` : "Its cost per conversion is not better than the account reference, so more budget is not automatically justified."),
        recommendation: efficient ? "Consider moving budget from weaker campaigns to this one, or raising its budget gradually while watching CPA." : "Improve efficiency before adding budget, or narrow targeting to the best-performing queries.",
        observed: { budget_lost_impression_share: round(lost, 3), campaign_cpa: cpa === null ? null : round(cpa) },
        thresholds: { budget_lost_share: THRESHOLDS.budgetLostShare, reference_cpa: reference === null ? null : round(reference) },
        source: diagnosticsSource(ctx),
        unavailable: diagnosticsCaveat(ctx),
      }];
    });
  },
};

const spendConcentration: Rule = {
  id: "budget.spend_concentration",
  category: "budget",
  applies(ctx) {
    return ctx.campaigns.filter((campaign) => campaign.spend > 0).length >= 3 ? null : "fewer than three spending campaigns";
  },
  run(ctx) {
    const spending = ctx.campaigns.filter((campaign) => campaign.spend > 0);
    if (spending.length < 3 || ctx.kpis.spend <= 0) return [];
    const top = spending.reduce((best, campaign) => (campaign.spend > best.spend ? campaign : best));
    const share = top.spend / ctx.kpis.spend;
    if (share < THRESHOLDS.concentrationShare) return [];
    return [{
      ruleId: "budget.spend_concentration",
      category: "budget",
      severity: "low",
      basis: "indicative",
      campaign: top,
      scoringGroup: "budget.concentration",
      title: `${formatPercent(share, 0)} of spend runs through one campaign`,
      description: `"${top.name}" accounts for ${money(ctx, top.spend)} of ${money(ctx, ctx.kpis.spend)}. This can be intentional, but results depend heavily on one campaign.`,
      recommendation: "Keep a planned testing budget in other campaigns or audiences so alternatives are ready if the main campaign's performance changes.",
      observed: { top_campaign_share: round(share, 3), campaigns_with_spend: spending.length },
      thresholds: { concentration_share: THRESHOLDS.concentrationShare },
      unavailable: [],
    }];
  },
};

// ---------------------------------------------------------------------------
// Trend (known days only, equal-length halves)
// ---------------------------------------------------------------------------

function halves(ctx: RuleContext) {
  const dates = [...ctx.quality.days.keys()].sort();
  const size = Math.floor(dates.length / 2);
  const first = dates.slice(0, size);
  const second = dates.slice(dates.length - size);
  const rows = new Map(ctx.quality.daily.map((row) => [row.date, row]));
  const sum = (part: string[]) => {
    let known = 0;
    let spend = 0;
    let conversions = 0;
    for (const date of part) {
      const state = ctx.quality.days.get(date);
      if (state === "missing") continue;
      known += 1;
      const row = rows.get(date);
      if (row) {
        spend += row.spend;
        conversions += row.conversions;
      }
    }
    return { days: part.length, known, spend, conversions, from: part[0], to: part.at(-1) };
  };
  return { first: sum(first), second: sum(second) };
}

const cpaTrend: Rule = {
  id: "trend.cpa_rising",
  category: "trend",
  applies(ctx) {
    const { first, second } = halves(ctx);
    if (first.known < THRESHOLDS.trendMinDaysPerHalf || second.known < THRESHOLDS.trendMinDaysPerHalf) return `fewer than ${THRESHOLDS.trendMinDaysPerHalf} known days in each half of the period`;
    if (first.known < first.days * 0.8 || second.known < second.days * 0.8) return "more than 20% of a half-period is missing";
    if (first.conversions < THRESHOLDS.trendMinConversionsPerHalf || second.conversions < THRESHOLDS.trendMinConversionsPerHalf) return `fewer than ${THRESHOLDS.trendMinConversionsPerHalf} conversions in each half`;
    return null;
  },
  run(ctx) {
    const { first, second } = halves(ctx);
    const before = first.spend / first.conversions;
    const after = second.spend / second.conversions;
    if (after < before * (1 + THRESHOLDS.trendCpaRise)) return [];
    return [{
      ruleId: "trend.cpa_rising",
      category: "trend",
      severity: after >= before * (1 + THRESHOLDS.trendCpaSevereRise) ? "high" : "medium",
      basis: "verified",
      scoringGroup: "trend.cpa",
      title: `Cost per conversion rose ${formatPercent(after / before - 1, 0)} between the two halves of the period`,
      description:
        `CPA was ${money(ctx, before)} from ${first.from} to ${first.to} (${formatNumber(first.conversions, 0)} conversions) and ${money(ctx, after)} from ${second.from} to ${second.to} (${formatNumber(second.conversions, 0)} conversions). ` +
        "Recent days can still gain late conversions, which would narrow the gap.",
      recommendation: "Look for creative fatigue, auction changes, tracking changes or budget increases in the second half of the period.",
      observed: { cpa_first_half: round(before), cpa_second_half: round(after), conversions_first_half: round(first.conversions), conversions_second_half: round(second.conversions) },
      thresholds: { rise: THRESHOLDS.trendCpaRise, min_conversions_per_half: THRESHOLDS.trendMinConversionsPerHalf },
      unavailable: [],
      estimatedImpact: round(Math.max(second.spend - second.conversions * before, 0)),
      estimateLabel: "Second-half spend above the first-half CPA (estimate)",
    }];
  },
};

const spendVolatility: Rule = {
  id: "trend.spend_volatility",
  category: "trend",
  applies(ctx) {
    const days = ctx.quality.daily.filter((row) => row.spend > 0).length;
    return days >= THRESHOLDS.volatilityMinDays ? null : `fewer than ${THRESHOLDS.volatilityMinDays} days with spend`;
  },
  run(ctx) {
    // Only days with delivery: missing days are unknown, and retrieved days
    // without delivery are reported separately rather than counted as low spend.
    const days = ctx.quality.daily.filter((row) => row.spend > 0);
    const mean = days.reduce((sum, row) => sum + row.spend, 0) / days.length;
    const variance = days.reduce((sum, row) => sum + (row.spend - mean) ** 2, 0) / days.length;
    const cv = Math.sqrt(variance) / mean;
    if (cv < THRESHOLDS.volatilityCv) return [];
    return [{
      ruleId: "trend.spend_volatility",
      category: "trend",
      severity: "low",
      basis: "indicative",
      scoringGroup: "trend.volatility",
      title: "Daily spend is highly irregular",
      description:
        `On the ${days.length} days with spend, daily spend varied by ${formatPercent(cv, 0)} (coefficient of variation) around ${money(ctx, mean)}. ` +
        `${ctx.quality.coverage.zeroDeliveryDays} retrieved day(s) had no delivery and ${ctx.quality.coverage.missingDays} day(s) are missing; neither is included. Planned bursts or promotions also cause this.`,
      recommendation: "If the swings are not planned, avoid large budget edits at once and check for budget caps or delivery interruptions.",
      observed: { coefficient_of_variation: round(cv, 2), average_daily_spend: round(mean), days_with_spend: days.length, zero_delivery_days: ctx.quality.coverage.zeroDeliveryDays },
      thresholds: { cv: THRESHOLDS.volatilityCv, min_days: THRESHOLDS.volatilityMinDays },
      unavailable: [],
    }];
  },
};

export const RULES: Rule[] = [
  noConversions,
  missingConversionValue,
  leadCounting,
  spendWithoutConversions,
  highCpaCampaign,
  lowRoasCampaign,
  accountRoas,
  wastedSearchTerms,
  lowCtr,
  highFrequency,
  lowConversionRate,
  adReview,
  adStrength,
  qualityScore,
  rankLostShare,
  noDelivery,
  fragmentation,
  learningLimited,
  manualBidding,
  underspend,
  budgetLostShare,
  spendConcentration,
  cpaTrend,
  spendVolatility,
];

export function toEvidence(ctx: RuleContext, draft: Draft): FindingEvidence {
  return {
    observed: draft.observed,
    thresholds: draft.thresholds,
    period: { start: ctx.period.start, end: ctx.period.end, days: ctx.period.days },
    source: draft.source ?? "daily campaign metrics",
    unavailable: draft.unavailable ?? [],
    campaign: draft.campaign?.name,
    account: ctx.account.name,
    reference: draft.reference,
  };
}

export type { AuditFinding };
