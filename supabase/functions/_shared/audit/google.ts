// Google Ads audit framework: Google-specific classification, thresholds,
// rules and scoring weights. Nothing here is applied to Meta accounts.
//
// Campaign types are evaluated separately: CPA, CTR and conversion-rate
// comparisons only use peers of the same campaign type (Search with Search,
// Performance Max with Performance Max), never one account-wide average.
// Thresholds are PRISIM heuristics unless a finding cites a benchmark or a
// business target.

import { formatMultiple, formatNumber, formatPercent, round } from "../format.ts";
import {
  type Classification,
  delivered,
  diagnosticsCaveat,
  diagnosticsSection,
  diagnosticsSource,
  type Draft,
  eligibleDays,
  groupHalves,
  isEnabled,
  median,
  money,
  type PlatformFramework,
  primaryReasons,
  ratio,
  type Rule,
  type RuleContext,
} from "./common.ts";
import { concentrationRule, fragmentationRule, noDeliveryRule, volatilityRule } from "./structural.ts";
import type { AuditCampaign, BusinessTarget, FindingBasis, Severity } from "./types.ts";

export const GOOGLE_THRESHOLDS = {
  minClicksForZeroConversions: 100,
  minCampaignClicksForZeroConversions: 50,
  minCampaignSpendShare: 0.08,
  minConversionsForCpa: 5,
  minPeers: 2,
  cpaOutlierMultiple: 2,
  cpaSevereMultiple: 3,
  minConversionsForValueCheck: 10,
  minImpressionsForCtr: 5000,
  ctrPeerFraction: 0.5,
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
  weakAssetGroupShare: 0.5,
} as const;

const T = GOOGLE_THRESHOLDS;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** advertising_channel_type -> campaign type. Google reports App campaigns as MULTI_CHANNEL. */
const KIND: Record<string, string> = {
  SEARCH: "search",
  SHOPPING: "shopping",
  PERFORMANCE_MAX: "pmax",
  DISPLAY: "display",
  VIDEO: "video",
  MULTI_CHANNEL: "app",
  DEMAND_GEN: "demand_gen",
  DISCOVERY: "demand_gen",
  SMART: "smart",
  LOCAL: "local",
  LOCAL_SERVICES: "local_services",
  HOTEL: "travel",
  TRAVEL: "travel",
};

export const GOOGLE_KIND_LABEL: Record<string, string> = {
  search: "Search",
  shopping: "Shopping",
  pmax: "Performance Max",
  display: "Display",
  video: "Video",
  app: "App",
  demand_gen: "Demand Gen",
  smart: "Smart",
  local: "Local",
  local_services: "Local Services",
  travel: "Travel",
  other: "Other",
};

const VALUE_BIDDING = new Set(["TARGET_ROAS", "MAXIMIZE_CONVERSION_VALUE"]);
const CONVERSION_BIDDING = new Set(["TARGET_CPA", "MAXIMIZE_CONVERSIONS"]);
const AWARENESS_BIDDING = new Set(["TARGET_CPM", "MANUAL_CPM", "MANUAL_CPV", "TARGET_CPV", "TARGET_IMPRESSION_SHARE", "FIXED_CPM"]);
const TRAFFIC_BIDDING = new Set(["TARGET_SPEND", "MAXIMIZE_CLICKS"]);

export function googleKind(campaign: Pick<AuditCampaign, "channelType" | "objective" | "details">): string {
  if ((campaign.details?.channelSubType ?? "").toUpperCase().startsWith("APP_CAMPAIGN")) return "app";
  return KIND[(campaign.channelType ?? campaign.objective ?? "").toUpperCase()] ?? "other";
}

export function classifyGoogle(campaign: AuditCampaign, target?: BusinessTarget | null): Classification {
  const kind = googleKind(campaign);
  const strategy = (campaign.bidStrategy ?? "").toUpperCase();
  let goal = "unknown";
  if (kind === "app") goal = "app";
  else if (VALUE_BIDDING.has(strategy) || kind === "shopping") goal = "sales";
  else if (CONVERSION_BIDDING.has(strategy)) goal = "conversions";
  else if (AWARENESS_BIDDING.has(strategy)) goal = "awareness";
  else if (TRAFFIC_BIDDING.has(strategy)) goal = "traffic";
  else if (kind === "pmax") goal = "conversions"; // Performance Max always bids for conversions or value.
  let uncertain = false;
  if (goal === "unknown") {
    uncertain = true;
    if (target?.goal) goal = target.goal;
  }
  const converts = ["sales", "leads", "app", "conversions"].includes(goal);
  return {
    kind,
    kindLabel: GOOGLE_KIND_LABEL[kind] ?? "Other",
    goal,
    resultMetric: converts ? "conversions" : null,
    resultLabel: converts ? (goal === "app" ? "app conversions" : "conversions") : null,
    uncertain,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function converting(ctx: RuleContext) {
  return ctx.campaigns.filter((campaign) => ctx.classify(campaign).resultMetric === "conversions");
}

/** Same-type peers (excluding the campaign itself). */
function peers(ctx: RuleContext, campaign: AuditCampaign, filter: (peer: AuditCampaign) => boolean) {
  const kind = ctx.classify(campaign).kind;
  return ctx.campaigns.filter((other) => other.id !== campaign.id && ctx.classify(other).kind === kind && filter(other));
}

type ConversionSetup =
  | { status: "unavailable"; reason: string }
  | { status: "ok"; enabled: number; primary: number; names: string[]; leadManyPerClick: string[]; appActions: number };

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
    appActions: primary.filter((row) => row.origin === "APP").length,
  };
}

function impressionShareRows(ctx: RuleContext) {
  const section = diagnosticsSection(ctx, "search_impression_share");
  if (section?.status !== "ok") return null;
  return section.rows.filter((row) => Number(row.impressions ?? 0) >= T.minImpressionsForImpressionShare);
}

/** Median CPA of same-type campaigns with enough conversions, or the business target. */
function cpaReference(ctx: RuleContext, campaign: AuditCampaign): { value: number; label: string; basis: FindingBasis; peers: number } | null {
  if (ctx.target?.targetCpa) return { value: ctx.target.targetCpa, label: "the target CPA", basis: "target", peers: 0 };
  const group = peers(ctx, campaign, (peer) => peer.conversions >= T.minConversionsForCpa);
  if (group.length < T.minPeers) return null;
  const value = median(group.map((peer) => peer.spend / peer.conversions));
  return value === null ? null : { value, label: `the median of ${group.length} other ${ctx.classify(campaign).kindLabel} campaign(s)`, basis: "indicative", peers: group.length };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const noConversions: Rule = {
  id: "tracking.no_conversions",
  category: "tracking",
  applies(ctx) {
    const relevant = converting(ctx);
    if (relevant.length === 0) return "no conversion-focused campaigns";
    const clicks = relevant.reduce((sum, campaign) => sum + campaign.clicks, 0);
    const setup = googleConversionSetup(ctx);
    if (clicks < T.minClicksForZeroConversions && !(setup.status === "ok" && setup.primary === 0)) return `fewer than ${T.minClicksForZeroConversions} clicks on conversion-focused campaigns`;
    return null;
  },
  run(ctx) {
    const relevant = converting(ctx);
    const spend = relevant.reduce((sum, campaign) => sum + campaign.spend, 0);
    const clicks = relevant.reduce((sum, campaign) => sum + campaign.clicks, 0);
    const conversions = relevant.reduce((sum, campaign) => sum + campaign.conversions, 0);
    if (conversions > 0 || spend <= 0) return [];
    const uncertain = relevant.filter((campaign) => ctx.classify(campaign).uncertain).length;
    const unavailable: string[] = uncertain > 0 ? [`campaign goal for ${uncertain} campaign(s) (manual bidding; assumed conversion-focused)`] : [];
    const observed = { spend: round(spend), clicks, conversions: 0, campaigns: relevant.length };
    const thresholds = { min_clicks: T.minClicksForZeroConversions };
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
        recommendation: "In Google Ads (Goals > Conversions), create or enable the conversion actions that represent business results and mark them as primary, then confirm they record test conversions.",
        observed: { ...observed, enabled_conversion_actions: setup.enabled, primary_conversion_actions: 0 },
        thresholds,
        source: `daily metrics and ${diagnosticsSource(ctx)}`,
        unavailable: [...unavailable, ...diagnosticsCaveat(ctx)],
        estimatedImpact: round(spend),
        estimateLabel: "Spend with no conversion measurement",
      }];
    }
    if (clicks < T.minClicksForZeroConversions) return [];
    const appOnly = relevant.every((campaign) => ctx.classify(campaign).kind === "app");
    return [{
      ruleId: "tracking.no_conversions",
      category: "tracking",
      severity: "high",
      basis: "indicative",
      title: `No conversions recorded for ${ctx.account.name}`,
      description:
        `${money(ctx, spend)} and ${formatNumber(clicks)} clicks on conversion-focused campaigns produced 0 recorded conversions. ` +
        (setup.status === "ok"
          ? `${setup.primary} primary conversion action(s) are enabled (${setup.names.join(", ")})` +
            (appOnly && setup.appActions === 0 ? ", none of them from an app (Firebase or app store), which App campaigns need." : ", so tracking is configured; zero conversions can mean the tag is not firing, conversions are attributed elsewhere, or the traffic did not convert.")
          : "The conversion action setup could not be read, so it is not known whether tracking is configured."),
      recommendation:
        appOnly
          ? "Check that the app's conversion events (Firebase or the app store) are linked and set as primary for this App campaign, and compare with installs in the app analytics."
          : "Check each primary conversion action's status and recent activity in Google Ads (Goals > Conversions), test the tag with Tag Assistant, and compare with conversions in the website analytics for the same period.",
      observed: setup.status === "ok" ? { ...observed, primary_conversion_actions: setup.primary, app_conversion_actions: setup.appActions } : observed,
      thresholds,
      source: setup.status === "ok" ? `daily metrics and ${diagnosticsSource(ctx)}` : "daily metrics",
      unavailable: [...unavailable, ...(setup.status === "ok" ? diagnosticsCaveat(ctx) : [`conversion action setup (${setup.reason})`]), "conversion tag diagnostics"],
      estimatedImpact: round(spend),
      estimateLabel: "Spend without recorded conversions",
    }];
  },
};

const missingConversionValue: Rule = {
  id: "tracking.no_conversion_value",
  category: "tracking",
  applies(ctx) {
    const sales = ctx.campaigns.filter((campaign) => ctx.classify(campaign).goal === "sales");
    if (sales.length === 0) return "no sales-focused campaigns (value bidding or Shopping)";
    const conversions = sales.reduce((sum, campaign) => sum + campaign.conversions, 0);
    return conversions >= T.minConversionsForValueCheck ? null : `fewer than ${T.minConversionsForValueCheck} conversions on sales-focused campaigns`;
  },
  run(ctx) {
    const sales = ctx.campaigns.filter((campaign) => ctx.classify(campaign).goal === "sales");
    const conversions = sales.reduce((sum, campaign) => sum + campaign.conversions, 0);
    if (sales.reduce((sum, campaign) => sum + campaign.conversionValue, 0) > 0) return [];
    return [{
      ruleId: "tracking.no_conversion_value",
      category: "tracking",
      severity: "medium",
      basis: "verified",
      title: "Sales campaigns report conversions without value",
      description: `${sales.length} sales-focused campaign(s) (value bidding or Shopping) recorded ${formatNumber(conversions, 0)} conversions with no conversion value, so return on ad spend cannot be measured.`,
      recommendation: "Send the transaction value and currency with each purchase conversion (or set a default value on the conversion action) so ROAS reporting and value-based bidding work.",
      observed: { sales_campaigns: sales.length, conversions: round(conversions), conversion_value: 0 },
      thresholds: { min_conversions: T.minConversionsForValueCheck },
      unavailable: [],
    }];
  },
};

const leadCounting: Rule = {
  id: "tracking.lead_counting",
  category: "tracking",
  applies(ctx) {
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
        "Repeat submissions by the same person are then counted as separate leads, which can overstate results.",
      recommendation: "Unless repeat leads are valuable to the business, switch these conversion actions to count one conversion per click.",
      observed: { lead_actions_counting_every: setup.leadManyPerClick.length },
      thresholds: { expected_counting: "ONE_PER_CLICK for leads" },
      source: diagnosticsSource(ctx),
      unavailable: [],
    }];
  },
};

const spendWithoutConversions: Rule = {
  id: "efficiency.spend_without_conversions",
  category: "efficiency",
  applies(ctx) {
    const ok = converting(ctx).some((campaign) => peers(ctx, campaign, (peer) => peer.conversions > 0).length > 0 && campaign.clicks >= T.minCampaignClicksForZeroConversions);
    return ok ? null : "no conversion-focused campaign with converting same-type peers and enough clicks";
  },
  run(ctx) {
    const total = ctx.kpis.spend;
    if (total <= 0) return [];
    return converting(ctx).flatMap((campaign): Draft[] => {
      if (campaign.conversions > 0 || campaign.clicks < T.minCampaignClicksForZeroConversions || campaign.spend < total * T.minCampaignSpendShare) return [];
      const converters = peers(ctx, campaign, (peer) => peer.conversions > 0);
      if (converters.length === 0) return [];
      const label = ctx.classify(campaign).kindLabel;
      return [{
        ruleId: "efficiency.spend_without_conversions",
        category: "efficiency",
        severity: "high",
        basis: "verified",
        campaign,
        scoringGroup: "efficiency.campaign_return",
        title: `"${campaign.name}" spent without converting`,
        description:
          `${money(ctx, campaign.spend)} (${formatPercent(campaign.spend / total, 1)} of account spend) produced ${formatNumber(campaign.clicks)} clicks and 0 conversions, ` +
          `while ${converters.length} other ${label} campaign(s) in the account recorded conversions.`,
        recommendation: "Review this campaign's targeting, search terms or audiences, landing page and conversion goal before deciding whether to reduce or reallocate its budget.",
        observed: { spend: round(campaign.spend), spend_share: round(campaign.spend / total, 3), clicks: campaign.clicks, conversions: 0, converting_peers: converters.length },
        thresholds: { min_spend_share: T.minCampaignSpendShare, min_clicks: T.minCampaignClicksForZeroConversions },
        unavailable: [],
        estimatedImpact: round(campaign.spend),
        estimateLabel: "Spend without recorded conversions",
      }];
    });
  },
};

const highCpa: Rule = {
  id: "efficiency.high_cpa_campaign",
  category: "efficiency",
  applies(ctx) {
    const ok = converting(ctx).some((campaign) => campaign.conversions >= T.minConversionsForCpa && cpaReference(ctx, campaign) !== null);
    return ok ? null : "no campaign with a same-type peer group (or target CPA) to compare cost per conversion";
  },
  run(ctx) {
    return converting(ctx).flatMap((campaign): Draft[] => {
      if (campaign.conversions < T.minConversionsForCpa || campaign.spend < ctx.kpis.spend * 0.05) return [];
      const reference = cpaReference(ctx, campaign);
      if (!reference) return [];
      const cpa = campaign.spend / campaign.conversions;
      if (cpa < reference.value * T.cpaOutlierMultiple) return [];
      return [{
        ruleId: "efficiency.high_cpa_campaign",
        category: "efficiency",
        severity: (cpa >= reference.value * T.cpaSevereMultiple ? "high" : "medium") as Severity,
        basis: reference.basis,
        campaign,
        scoringGroup: "efficiency.campaign_return",
        title: `"${campaign.name}" costs ${formatMultiple(cpa / reference.value, 1)} ${reference.basis === "target" ? "the target" : "its peers"} per conversion`,
        description: `Cost per conversion is ${money(ctx, cpa)} across ${formatNumber(campaign.conversions, 0)} conversions, against ${reference.label} of ${money(ctx, reference.value)}.`,
        recommendation: "Check that this campaign's conversions are the same kind as its peers'; if they are, tighten targeting or creative and test moving budget toward campaigns at or below the reference.",
        observed: { campaign_cpa: round(cpa), conversions: round(campaign.conversions), spend: round(campaign.spend) },
        thresholds: { reference_cpa: round(reference.value), multiple: T.cpaOutlierMultiple, peers: reference.peers },
        reference: reference.basis === "target" ? "business target CPA supplied by PRISIM" : undefined,
        unavailable: [],
        estimatedImpact: round(Math.max(campaign.spend - campaign.conversions * reference.value, 0)),
        estimateLabel: "Spend above the reference CPA (estimate)",
      }];
    });
  },
};

const lowRoas: Rule = {
  id: "efficiency.low_roas_campaign",
  category: "efficiency",
  applies(ctx) {
    return ctx.campaigns.some((campaign) => ctx.classify(campaign).goal === "sales" && campaign.conversionValue > 0) ? null : "no sales-focused campaigns that report conversion value";
  },
  run(ctx) {
    const targetRoas = ctx.target?.targetRoas ?? null;
    const floor = targetRoas ?? 1;
    return ctx.campaigns.flatMap((campaign): Draft[] => {
      if (ctx.classify(campaign).goal !== "sales" || campaign.conversionValue <= 0) return [];
      if (campaign.spend < ctx.kpis.spend * 0.05 || campaign.conversions < T.minConversionsForCpa) return [];
      const roas = campaign.conversionValue / campaign.spend;
      if (roas >= floor) return [];
      return [{
        ruleId: "efficiency.low_roas_campaign",
        category: "efficiency",
        severity: (roas < 1 ? "high" : "medium") as Severity,
        basis: (targetRoas ? "target" : "verified") as FindingBasis,
        campaign,
        scoringGroup: "efficiency.campaign_return",
        title: `"${campaign.name}" returns ${formatMultiple(roas)} on ad spend`,
        description:
          `${money(ctx, campaign.conversionValue)} of reported conversion value from ${money(ctx, campaign.spend)} of spend` +
          (targetRoas ? `, below the target ROAS of ${formatMultiple(targetRoas)}.` : ", so reported value is below spend.") +
          " Reported value is platform-attributed revenue, not profit.",
        recommendation: "Confirm the reported value matches actual revenue, then set or lower a target ROAS and exclude low-value products or audiences.",
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
    return ctx.campaigns.some((campaign) => ctx.classify(campaign).goal === "sales" && campaign.conversionValue > 0) ? null : "no sales-focused campaigns that report conversion value";
  },
  run(ctx) {
    // Only sales-focused campaigns: lead and app campaigns are not expected to report revenue.
    const sales = ctx.campaigns.filter((campaign) => ctx.classify(campaign).goal === "sales");
    const spend = sales.reduce((sum, campaign) => sum + campaign.spend, 0);
    const value = sales.reduce((sum, campaign) => sum + campaign.conversionValue, 0);
    const roas = ratio(value, spend);
    const targetRoas = ctx.target?.targetRoas ?? null;
    const floor = targetRoas ?? 1;
    if (roas === null || roas >= floor) return [];
    return [{
      ruleId: "efficiency.account_roas",
      category: "efficiency",
      severity: roas < 1 ? "high" : "medium",
      basis: targetRoas ? "target" : "verified",
      scoringGroup: "efficiency.account_return",
      title: `Sales campaigns return ${formatMultiple(roas)} on ad spend`,
      description: `${sales.length} sales-focused campaign(s) reported ${money(ctx, value)} of conversion value from ${money(ctx, spend)} of spend${targetRoas ? `, below the target ROAS of ${formatMultiple(targetRoas)}` : ""}. Reported value is attributed by Google and is not profit.`,
      recommendation: "Agree a margin-based ROAS target with the business, prioritize the highest-return campaigns and confirm the value tracking reflects real revenue.",
      observed: { roas: round(roas, 2), spend: round(spend), conversion_value: round(value) },
      thresholds: { roas_floor: floor },
      reference: targetRoas ? "business target ROAS supplied by PRISIM" : undefined,
      unavailable: targetRoas ? [] : ["business ROAS target", "product margins"],
    }];
  },
};

function searchTermRule(id: "efficiency.search_terms" | "efficiency.pmax_search_terms", section: string, kinds: string[], view: string): Rule {
  return {
    id,
    category: "efficiency",
    applies(ctx) {
      if (!ctx.campaigns.some((campaign) => kinds.includes(ctx.classify(campaign).kind) && delivered(campaign))) {
        return `no ${kinds.map((kind) => GOOGLE_KIND_LABEL[kind]).join(" or ")} campaigns with delivery`;
      }
      const data = diagnosticsSection(ctx, section);
      if (!data) return `${view} was not captured`;
      return data.status === "ok" ? null : `${view} unavailable: ${data.reason}`;
    },
    run(ctx) {
      const data = diagnosticsSection(ctx, section);
      if (data?.status !== "ok") return [];
      const rows = data.rows.map((row) => ({
        term: String(row.search_term ?? ""),
        status: String(row.status ?? ""),
        clicks: Number(row.clicks ?? 0),
        cost: Number(row.cost ?? 0),
        conversions: Number(row.conversions ?? 0),
      }));
      const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);
      const candidates = rows.filter((row) => row.conversions === 0 && row.clicks >= T.searchTermMinClicks && row.status !== "EXCLUDED" && row.status !== "ADDED_EXCLUDED");
      const cost = candidates.reduce((sum, row) => sum + row.cost, 0);
      if (totalCost <= 0 || candidates.length < 3 || cost / totalCost < T.searchTermCostShare) return [];
      const share = cost / totalCost;
      const pmax = id === "efficiency.pmax_search_terms";
      return [{
        ruleId: id,
        category: "efficiency",
        severity: share >= 0.25 ? "medium" : "low",
        basis: "indicative",
        scoringGroup: id,
        title: `${candidates.length} ${pmax ? "Performance Max " : ""}search terms took ${formatPercent(share, 0)} of search-term spend without converting`,
        description:
          `Top examples: ${candidates.slice(0, 5).map((row) => `"${row.term}" (${money(ctx, row.cost)}, ${row.clicks} clicks)`).join(", ")}. ` +
          "Whether these queries are irrelevant needs human review; some may convert later or assist other conversions.",
        recommendation: pmax
          ? "Review the listed queries; exclude irrelevant themes with account-level negative keywords or brand exclusions for Performance Max."
          : "Review the listed queries and add the irrelevant ones as negative keywords; keep relevant non-converting queries under observation.",
        observed: { candidate_terms: candidates.length, candidate_cost: round(cost), search_term_cost: round(totalCost), cost_share: round(share, 3) },
        thresholds: { min_clicks: T.searchTermMinClicks, min_cost_share: T.searchTermCostShare },
        source: `${view}, ${diagnosticsSource(ctx)}`,
        unavailable: [...(pmax ? [] : ["Performance Max search terms (reported separately)"]), ...diagnosticsCaveat(ctx, data.truncated === true)],
        estimatedImpact: round(cost),
        estimateLabel: "Spend on non-converting search terms (to review)",
      }];
    },
  };
}

/** CTR matters for these types; Performance Max, Video and App optimize for other outcomes. */
const CTR_KINDS = new Set(["search", "shopping", "display", "demand_gen"]);

const lowCtr: Rule = {
  id: "engagement.low_ctr",
  category: "engagement",
  applies(ctx) {
    const ok = ctx.campaigns.some((campaign) => {
      const kind = ctx.classify(campaign).kind;
      if (!CTR_KINDS.has(kind) || campaign.impressions < T.minImpressionsForCtr) return false;
      return ctx.benchmarks.some((item) => item.provider === "google" && item.kind === kind) || peers(ctx, campaign, (peer) => peer.impressions >= T.minImpressionsForCtr).length >= T.minPeers;
    });
    return ok ? null : "no Search/Shopping/Display/Demand Gen campaign with same-type peers or a sourced benchmark";
  },
  run(ctx) {
    return ctx.campaigns.flatMap((campaign): Draft[] => {
      const { kind, kindLabel } = ctx.classify(campaign);
      if (!CTR_KINDS.has(kind) || campaign.impressions < T.minImpressionsForCtr) return [];
      const ctr = campaign.clicks / campaign.impressions;
      const benchmark = ctx.benchmarks.find((item) => item.metric === "ctr" && item.provider === "google" && item.kind === kind);
      if (benchmark) {
        if (ctr >= benchmark.value) return [];
        return [{
          ruleId: "engagement.low_ctr",
          category: "engagement",
          severity: (ctr < benchmark.value * 0.5 ? "medium" : "low") as Severity,
          basis: "benchmark",
          campaign,
          scoringGroup: "engagement.relevance",
          title: `"${campaign.name}" click-through rate is below the ${kindLabel} benchmark`,
          description: `CTR is ${formatPercent(ctr)} on ${formatNumber(campaign.impressions)} impressions against ${formatPercent(benchmark.value)} (${benchmark.source}; ${benchmark.applicability}). Benchmarks are indicative, not targets.`,
          recommendation: "Test ad copy and assets that match the audience's intent, and check targeting relevance.",
          observed: { ctr: round(ctr * 100, 3), impressions: campaign.impressions, clicks: campaign.clicks },
          thresholds: { benchmark_ctr: round(benchmark.value * 100, 3) },
          reference: `${benchmark.source} (${benchmark.applicability})`,
          unavailable: [],
        }];
      }
      const group = peers(ctx, campaign, (peer) => peer.impressions >= T.minImpressionsForCtr);
      if (group.length < T.minPeers) return [];
      const peerCtr = median(group.map((peer) => peer.clicks / peer.impressions));
      if (peerCtr === null || ctr >= peerCtr * T.ctrPeerFraction) return [];
      return [{
        ruleId: "engagement.low_ctr",
        category: "engagement",
        severity: (ctr < peerCtr / 3 ? "medium" : "low") as Severity,
        basis: "indicative",
        campaign,
        scoringGroup: "engagement.relevance",
        title: `"${campaign.name}" click-through rate is well below other ${kindLabel} campaigns`,
        description: `CTR is ${formatPercent(ctr)} on ${formatNumber(campaign.impressions)} impressions against a median of ${formatPercent(peerCtr)} for ${group.length} other ${kindLabel} campaign(s) in this account. No external benchmark is applied.`,
        recommendation: kind === "search" || kind === "shopping"
          ? "Check ad relevance: tighten keyword-to-ad grouping, add ad variations and assets, and review search terms."
          : "Test new creative and review audience and placement targeting.",
        observed: { ctr: round(ctr * 100, 3), impressions: campaign.impressions, clicks: campaign.clicks },
        thresholds: { peer_median_ctr: round(peerCtr * 100, 3), fraction_of_peer: T.ctrPeerFraction, peers: group.length },
        unavailable: ["sourced external CTR benchmark"],
      }];
    });
  },
};

const lowConversionRate: Rule = {
  id: "engagement.low_conversion_rate",
  category: "engagement",
  applies(ctx) {
    const ok = converting(ctx).some((campaign) => campaign.clicks >= T.minClicksForConversionRate && peers(ctx, campaign, (peer) => peer.clicks >= T.minClicksForConversionRate && peer.conversions > 0).length >= T.minPeers);
    return ok ? null : "no converting campaign with enough same-type peers to compare conversion rate";
  },
  run(ctx) {
    return converting(ctx).flatMap((campaign): Draft[] => {
      if (campaign.clicks < T.minClicksForConversionRate) return [];
      const group = peers(ctx, campaign, (peer) => peer.clicks >= T.minClicksForConversionRate && peer.conversions > 0);
      if (group.length < T.minPeers) return [];
      const rate = campaign.conversions / campaign.clicks;
      const peerRate = median(group.map((peer) => peer.conversions / peer.clicks));
      if (peerRate === null || rate >= peerRate * T.conversionRatePeerFraction) return [];
      return [{
        ruleId: "engagement.low_conversion_rate",
        category: "engagement",
        severity: "low",
        basis: "indicative",
        campaign,
        scoringGroup: "engagement.relevance",
        title: `"${campaign.name}" converts far fewer clicks than other ${ctx.classify(campaign).kindLabel} campaigns`,
        description: `${formatPercent(rate)} of ${formatNumber(campaign.clicks)} clicks converted, against a median of ${formatPercent(peerRate)} for ${group.length} same-type campaign(s).`,
        recommendation: "Compare the landing page, offer and query intent with the better-converting campaigns.",
        observed: { conversion_rate: round(rate * 100, 2), clicks: campaign.clicks, conversions: round(campaign.conversions) },
        thresholds: { peer_median_conversion_rate: round(peerRate * 100, 2), fraction_of_peer: T.conversionRatePeerFraction },
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
    const byCampaign = new Map<string, { enabled: number; disapproved: number; limited: number }>();
    for (const row of section.rows) {
      if (row.status !== "ENABLED") continue;
      const id = String(row.campaign_id ?? "");
      const entry = byCampaign.get(id) ?? { enabled: 0, disapproved: 0, limited: 0 };
      entry.enabled += 1;
      if (row.approval_status === "DISAPPROVED") entry.disapproved += 1;
      if (row.approval_status === "APPROVED_LIMITED") entry.limited += 1;
      byCampaign.set(id, entry);
    }
    return ctx.campaigns.flatMap((campaign): Draft[] => {
      if (!isEnabled(campaign) || !campaign.externalId) return [];
      const entry = byCampaign.get(campaign.externalId);
      if (!entry || entry.disapproved === 0) return [];
      const share = entry.disapproved / entry.enabled;
      return [{
        ruleId: "engagement.ad_review",
        category: "engagement",
        severity: (share >= 1 ? "high" : share >= 0.25 ? "medium" : "low") as Severity,
        basis: "verified",
        campaign,
        scoringGroup: "engagement.ad_review",
        title: `${entry.disapproved} of ${entry.enabled} enabled ads in "${campaign.name}" are disapproved`,
        description: `At capture time: ${entry.disapproved} disapproved${entry.limited ? `, ${entry.limited} approved with limitations` : ""}. Disapproved ads do not serve; the status may have changed since capture.`,
        recommendation: "Open the policy details for each disapproved ad, fix the cited issue or appeal, and replace ads that cannot be approved.",
        observed: { enabled_ads: entry.enabled, disapproved: entry.disapproved, approved_limited: entry.limited },
        thresholds: { any_disapproved: true },
        source: diagnosticsSource(ctx),
        unavailable: ["ad status history during the period", ...diagnosticsCaveat(ctx, section.truncated === true)],
      }];
    });
  },
};

const adStrength: Rule = {
  id: "engagement.ad_strength",
  category: "engagement",
  applies(ctx) {
    const section = diagnosticsSection(ctx, "ads");
    if (section?.status !== "ok") return "ads were not captured";
    return section.rows.some((row) => row.ad_type === "RESPONSIVE_SEARCH_AD") ? null : "no responsive search ads";
  },
  run(ctx) {
    const section = diagnosticsSection(ctx, "ads");
    if (section?.status !== "ok") return [];
    const rated = section.rows.filter((row) => row.ad_type === "RESPONSIVE_SEARCH_AD" && row.status === "ENABLED" && ["POOR", "AVERAGE", "GOOD", "EXCELLENT"].includes(String(row.ad_strength)));
    const poor = rated.filter((row) => row.ad_strength === "POOR");
    if (rated.length === 0 || poor.length / rated.length < 0.25) return [];
    return [{
      ruleId: "engagement.ad_strength",
      category: "engagement",
      severity: "low",
      basis: "verified",
      scoringGroup: "engagement.creative",
      title: `${poor.length} of ${rated.length} responsive search ads have Poor ad strength`,
      description: "Ad strength is Google's rating of headline and description variety and relevance. Poor-rated ads limit the combinations Google can test. It is a guide, not a ranking factor by itself.",
      recommendation: "Add distinct headlines and descriptions that include the main keywords, and avoid pinning assets unless required.",
      observed: { rated_ads: rated.length, poor_ads: poor.length },
      thresholds: { poor_share: 0.25 },
      source: diagnosticsSource(ctx),
      unavailable: diagnosticsCaveat(ctx, section.truncated === true),
    }];
  },
};

const assetGroupStrength: Rule = {
  id: "engagement.asset_group_strength",
  category: "engagement",
  applies(ctx) {
    if (!ctx.campaigns.some((campaign) => ctx.classify(campaign).kind === "pmax")) return "no Performance Max campaigns";
    const section = diagnosticsSection(ctx, "asset_groups");
    if (!section) return "asset groups were not captured";
    return section.status === "ok" ? null : `asset groups unavailable: ${section.reason}`;
  },
  run(ctx) {
    const section = diagnosticsSection(ctx, "asset_groups");
    if (section?.status !== "ok") return [];
    return ctx.campaigns.flatMap((campaign): Draft[] => {
      if (ctx.classify(campaign).kind !== "pmax" || !campaign.externalId || !delivered(campaign)) return [];
      const groups = section.rows.filter((row) => row.campaign_id === campaign.externalId && row.status === "ENABLED" && ["POOR", "AVERAGE", "GOOD", "EXCELLENT"].includes(String(row.ad_strength)));
      const weak = groups.filter((row) => row.ad_strength === "POOR" || row.ad_strength === "AVERAGE");
      if (groups.length === 0 || weak.length / groups.length < T.weakAssetGroupShare) return [];
      return [{
        ruleId: "engagement.asset_group_strength",
        category: "engagement",
        severity: "low",
        basis: "verified",
        campaign,
        scoringGroup: "engagement.creative",
        title: `${weak.length} of ${groups.length} asset groups in "${campaign.name}" have Poor or Average ad strength`,
        description: "Asset group ad strength reflects how many and how varied the headlines, descriptions, images and videos are. Weak asset groups give Performance Max fewer combinations to serve.",
        recommendation: "Add the missing asset types (images in all ratios, videos, headlines and descriptions) to the weak asset groups.",
        observed: { rated_asset_groups: groups.length, weak_asset_groups: weak.length, examples: weak.slice(0, 3).map((row) => String(row.name ?? row.asset_group_id)).join(", ") },
        thresholds: { weak_share: T.weakAssetGroupShare },
        source: diagnosticsSource(ctx),
        unavailable: ["asset-level performance labels", ...diagnosticsCaveat(ctx, section.truncated === true)],
      }];
    });
  },
};

const qualityScore: Rule = {
  id: "engagement.quality_score",
  category: "engagement",
  applies(ctx) {
    if (!ctx.campaigns.some((campaign) => ctx.classify(campaign).kind === "search")) return "no Search campaigns";
    const section = diagnosticsSection(ctx, "keywords");
    if (section?.status !== "ok") return "keyword Quality Score was not captured";
    return section.rows.some((row) => typeof row.quality_score === "number" && Number(row.cost ?? 0) > 0) ? null : "no keywords with spend and a Quality Score";
  },
  run(ctx) {
    const section = diagnosticsSection(ctx, "keywords");
    if (section?.status !== "ok") return [];
    const rows = section.rows.filter((row) => typeof row.quality_score === "number" && Number(row.cost ?? 0) > 0);
    const total = rows.reduce((sum, row) => sum + Number(row.cost), 0);
    const low = rows.filter((row) => Number(row.quality_score) <= T.lowQualityScore);
    const lowCost = low.reduce((sum, row) => sum + Number(row.cost), 0);
    if (total <= 0 || lowCost / total < T.lowQualityCostShare) return [];
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
      title: `${formatPercent(share, 0)} of keyword spend is on keywords with Quality Score ${T.lowQualityScore} or lower`,
      description:
        `${low.length} keyword(s) with a Quality Score of ${T.lowQualityScore} or lower account for ${money(ctx, lowCost)} of ${money(ctx, total)} keyword spend. ` +
        (worst && worst[1] > 0 ? `The most common below-average component is ${labels[worst[0]]} (${worst[1]} keywords).` : ""),
      recommendation: "Improve the weakest component: tighter ad groups and ad copy for expected CTR and ad relevance, faster and more relevant pages for landing page experience.",
      observed: { low_qs_keywords: low.length, low_qs_cost: round(lowCost), keyword_cost: round(total), ...Object.fromEntries(components.map(([field, count]) => [`below_average_${field}`, count])) },
      thresholds: { quality_score_at_most: T.lowQualityScore, min_cost_share: T.lowQualityCostShare },
      source: diagnosticsSource(ctx),
      unavailable: diagnosticsCaveat(ctx, section.truncated === true),
    }];
  },
};

const rankLost: Rule = {
  id: "engagement.rank_lost_impression_share",
  category: "engagement",
  applies(ctx) {
    const rows = impressionShareRows(ctx);
    return rows && rows.length > 0 ? null : "Search impression share was not captured or no Search campaign had enough impressions";
  },
  run(ctx) {
    return (impressionShareRows(ctx) ?? []).flatMap((row): Draft[] => {
      const lost = typeof row.search_rank_lost_impression_share === "number" ? row.search_rank_lost_impression_share : null;
      const campaign = ctx.campaigns.find((item) => item.externalId === row.campaign_id);
      if (lost === null || !campaign || lost < T.rankLostShare) return [];
      return [{
        ruleId: "engagement.rank_lost_impression_share",
        category: "engagement",
        severity: "low",
        basis: "verified",
        campaign,
        scoringGroup: "engagement.relevance",
        title: `"${campaign.name}" lost ${formatPercent(lost, 0)} of Search impressions to ad rank`,
        description: "Lost impression share (rank) is the share of eligible impressions missed because of low ad rank (bids, quality and ad assets).",
        recommendation: "Improve Quality Score components and ad assets before raising bids; check whether the missed auctions are valuable.",
        observed: { rank_lost_impression_share: round(lost, 3), search_impression_share: typeof row.search_impression_share === "number" ? round(row.search_impression_share, 3) : null },
        thresholds: { rank_lost_share: T.rankLostShare },
        source: diagnosticsSource(ctx),
        unavailable: diagnosticsCaveat(ctx),
      }];
    });
  },
};

const MANUAL_BIDDING = new Set(["MANUAL_CPC", "ENHANCED_CPC"]);

const manualBidding: Rule = {
  id: "structure.manual_bidding",
  category: "structure",
  applies(ctx) {
    return ctx.campaigns.some((campaign) => MANUAL_BIDDING.has((campaign.bidStrategy ?? "").toUpperCase())) ? null : "no campaigns with manual CPC bidding";
  },
  run(ctx) {
    return ctx.campaigns.flatMap((campaign): Draft[] => {
      const strategy = (campaign.bidStrategy ?? "").toUpperCase();
      if (!MANUAL_BIDDING.has(strategy) || campaign.conversions < T.manualBiddingMinConversions) return [];
      return [{
        ruleId: "structure.manual_bidding",
        category: "structure",
        severity: "low",
        basis: "indicative",
        campaign,
        scoringGroup: "structure.bidding",
        title: `"${campaign.name}" uses manual bidding with enough conversions to test Smart Bidding`,
        description: `The campaign uses ${strategy.replace(/_/g, " ").toLowerCase()} and recorded ${formatNumber(campaign.conversions, 0)} conversions in the period. Manual bidding can be a deliberate choice.`,
        recommendation: "Test Maximize Conversions with a target CPA (or value with a target ROAS) as a campaign experiment against the current setup.",
        observed: { bid_strategy: strategy, conversions: round(campaign.conversions) },
        thresholds: { min_conversions: T.manualBiddingMinConversions },
        unavailable: [],
      }];
    });
  },
};

const underspend: Rule = {
  id: "budget.underspend",
  category: "budget",
  applies(ctx) {
    const ok = ctx.campaigns.some((campaign) => isEnabled(campaign) && delivered(campaign) && (campaign.dailyBudget ?? 0) > 0 && eligibleDays(ctx, campaign).known >= T.minEligibleDays);
    return ok ? null : "no enabled, delivering campaign with a known daily budget";
  },
  run(ctx) {
    const drafts: Draft[] = [];
    const sharedDone = new Set<string>();
    for (const campaign of ctx.campaigns) {
      if (!isEnabled(campaign) || !delivered(campaign) || !campaign.dailyBudget || campaign.dailyBudget <= 0) continue;
      const shared = campaign.details?.budgetShared === true && campaign.details.budgetId ? campaign.details.budgetId : null;
      if (shared && sharedDone.has(shared)) continue;
      const group = shared ? ctx.campaigns.filter((other) => other.details?.budgetId === shared) : [campaign];
      if (shared) sharedDone.add(shared);
      const days = eligibleDays(ctx, campaign);
      if (days.known < T.minEligibleDays) continue;
      const average = group.reduce((sum, item) => sum + item.spend, 0) / days.known;
      if (average >= campaign.dailyBudget * T.underspendFraction) continue;
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
          `Average spend per known day was ${money(ctx, average)} over ${days.known} day(s), ${formatPercent(average / campaign.dailyBudget, 0)} of the current daily budget of ${money(ctx, campaign.dailyBudget)}. ` +
          "The budget may have been changed during the period. The cause is not determined by this data" +
          (reasons ? `; Google reports ${reasons}.` : "; common causes include bid or target limits, narrow targeting, ad review status and low search volume."),
        recommendation: "Check the campaign's status details in Google Ads, and either address the limiting factor or lower the budget so the unused amount can be planned elsewhere.",
        observed: { average_daily_spend: round(average), daily_budget: round(campaign.dailyBudget), known_days: days.known, campaigns_sharing_budget: group.length, primary_status_reasons: reasons },
        thresholds: { min_utilization: T.underspendFraction },
        unavailable,
      });
    }
    return drafts;
  },
};

const budgetLost: Rule = {
  id: "budget.lost_impression_share",
  category: "budget",
  applies(ctx) {
    const rows = impressionShareRows(ctx);
    return rows && rows.length > 0 ? null : "Search impression share was not captured or no Search campaign had enough impressions";
  },
  run(ctx) {
    return (impressionShareRows(ctx) ?? []).flatMap((row): Draft[] => {
      const lost = typeof row.search_budget_lost_impression_share === "number" ? row.search_budget_lost_impression_share : null;
      const campaign = ctx.campaigns.find((item) => item.externalId === row.campaign_id);
      if (lost === null || !campaign || lost < T.budgetLostShare) return [];
      const cpa = ratio(campaign.spend, campaign.conversions);
      const reference = cpaReference(ctx, campaign);
      const efficient = cpa !== null && reference !== null && cpa <= reference.value;
      return [{
        ruleId: "budget.lost_impression_share",
        category: "budget",
        severity: (efficient ? "medium" : "low") as Severity,
        basis: "verified",
        campaign,
        scoringGroup: "budget.limited",
        title: `"${campaign.name}" lost ${lost >= 0.9 ? "over 90%" : formatPercent(lost, 0)} of Search impressions to budget`,
        description:
          "Google reports that the campaign missed this share of eligible impressions because the budget ran out. " +
          (efficient
            ? `Its cost per conversion (${money(ctx, cpa)}) is at or below ${reference!.label} (${money(ctx, reference!.value)}).`
            : "Its cost per conversion is not shown to be better than comparable Search campaigns, so more budget is not automatically justified."),
        recommendation: efficient ? "Consider moving budget from weaker Search campaigns to this one, or raising its budget gradually while watching CPA." : "Improve efficiency before adding budget, or narrow targeting to the best-performing queries.",
        observed: { budget_lost_impression_share: round(lost, 3), campaign_cpa: cpa === null ? null : round(cpa) },
        thresholds: { budget_lost_share: T.budgetLostShare, reference_cpa: reference ? round(reference.value) : null },
        source: diagnosticsSource(ctx),
        unavailable: diagnosticsCaveat(ctx),
      }];
    });
  },
};

const cpaTrend: Rule = {
  id: "trend.cpa_rising",
  category: "trend",
  applies(ctx) {
    return trendGroups(ctx).length > 0 ? null : `no campaign type with ${T.trendMinConversionsPerHalf}+ conversions in each half on ${T.trendMinDaysPerHalf}+ known days`;
  },
  run(ctx) {
    return trendGroups(ctx).flatMap(({ kind, halves }): Draft[] => {
      const before = halves.first.cost / (halves.first.result as number);
      const after = halves.second.cost / (halves.second.result as number);
      if (after < before * (1 + T.trendCpaRise)) return [];
      const label = GOOGLE_KIND_LABEL[kind] ?? kind;
      return [{
        ruleId: "trend.cpa_rising",
        category: "trend",
        severity: after >= before * (1 + T.trendCpaSevereRise) ? "high" : "medium",
        basis: "verified",
        scoringGroup: `trend.cpa.${kind}`,
        title: `${label} cost per conversion rose ${formatPercent(after / before - 1, 0)} between the two halves of the period`,
        description:
          `${label} CPA was ${money(ctx, before)} from ${halves.first.from} to ${halves.first.to} (${formatNumber(halves.first.result, 0)} conversions) and ${money(ctx, after)} from ${halves.second.from} to ${halves.second.to} (${formatNumber(halves.second.result, 0)} conversions). ` +
          "Recent days can still gain late conversions, which would narrow the gap.",
        recommendation: "Look for creative or ad changes, auction changes, tracking changes or budget increases in the second half of the period.",
        observed: { campaign_type: label, cpa_first_half: round(before), cpa_second_half: round(after), conversions_first_half: round(halves.first.result as number), conversions_second_half: round(halves.second.result as number) },
        thresholds: { rise: T.trendCpaRise, min_conversions_per_half: T.trendMinConversionsPerHalf },
        unavailable: [],
        estimatedImpact: round(Math.max(halves.second.cost - (halves.second.result as number) * before, 0)),
        estimateLabel: "Second-half spend above the first-half CPA (estimate)",
      }];
    });
  },
};

function trendGroups(ctx: RuleContext) {
  const byKind = new Map<string, Set<string>>();
  for (const campaign of converting(ctx)) {
    const kind = ctx.classify(campaign).kind;
    byKind.set(kind, (byKind.get(kind) ?? new Set()).add(campaign.id));
  }
  const groups: Array<{ kind: string; halves: NonNullable<ReturnType<typeof groupHalves>> }> = [];
  for (const [kind, ids] of byKind) {
    const halves = groupHalves(ctx, ids, (row) => ({ cost: row.spend, result: row.conversions, impressions: row.impressions, clicks: row.clicks }));
    if (!halves) continue;
    const { first, second } = halves;
    if (first.known < T.trendMinDaysPerHalf || second.known < T.trendMinDaysPerHalf) continue;
    if (first.known < first.days * 0.8 || second.known < second.days * 0.8) continue;
    if ((first.result ?? 0) < T.trendMinConversionsPerHalf || (second.result ?? 0) < T.trendMinConversionsPerHalf) continue;
    groups.push({ kind, halves });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Framework
// ---------------------------------------------------------------------------

export const GOOGLE_FRAMEWORK: PlatformFramework = {
  provider: "google",
  label: "Google Ads",
  classify: classifyGoogle,
  thresholds: GOOGLE_THRESHOLDS,
  rules: [
    noConversions,
    missingConversionValue,
    leadCounting,
    spendWithoutConversions,
    highCpa,
    lowRoas,
    accountRoas,
    searchTermRule("efficiency.search_terms", "search_terms", ["search", "shopping"], "search_term_view"),
    searchTermRule("efficiency.pmax_search_terms", "pmax_search_terms", ["pmax"], "campaign_search_term_view"),
    lowCtr,
    lowConversionRate,
    adReview,
    adStrength,
    assetGroupStrength,
    qualityScore,
    rankLost,
    noDeliveryRule({
      minKnownDays: T.minEligibleDays,
      highAfterDays: 14,
      recommendation: "Open the campaign in Google Ads and review its status column and policy, billing, targeting, bid and budget details; if it is no longer needed, pause it.",
      unavailableWithoutStatus: "campaign primary status",
    }),
    fragmentationRule({ minCampaigns: T.fragmentationMinCampaigns, smallShare: T.fragmentationSmallShare, note: "Thin budgets give Smart Bidding little data per campaign. Separate campaigns can be intentional (regions, brand vs generic)." }),
    manualBidding,
    underspend,
    budgetLost,
    concentrationRule({ share: T.concentrationShare, note: "This can be intentional, but results depend heavily on one campaign." }),
    cpaTrend,
    volatilityRule({ minDays: T.volatilityMinDays, cv: T.volatilityCv }),
  ],
  scoring: {
    // Google: conversion measurement and cost efficiency first; budget and
    // impression share matter more than on Meta because Search is demand-capped.
    weights: { tracking: 0.25, efficiency: 0.25, engagement: 0.15, structure: 0.1, budget: 0.15, trend: 0.1 },
    severityPenalty: { critical: 35, high: 20, medium: 10, low: 4, info: 0 },
    basisFactor: { verified: 1, target: 1, benchmark: 0.5, indicative: 0.5, unavailable: 0 },
    caps: { critical: 59, high: 79 },
    minAssessedWeight: 0.5,
    fullAssessedWeight: 0.75,
    method:
      "Google Ads score: areas are weighted tracking 25%, efficiency 25%, engagement 15%, structure 10%, budget 15%, trend 10%. " +
      "A verified critical finding caps the account score at 59, a verified high finding at 79.",
  },
  platformKpis(campaigns, ctx) {
    const result: Record<string, number | null> = {};
    const byKind = new Map<string, { spend: number; conversions: number; impressions: number; clicks: number }>();
    for (const campaign of campaigns) {
      const kind = ctx.classify(campaign).kind;
      const entry = byKind.get(kind) ?? { spend: 0, conversions: 0, impressions: 0, clicks: 0 };
      entry.spend += campaign.spend;
      entry.conversions += campaign.conversions;
      entry.impressions += campaign.impressions;
      entry.clicks += campaign.clicks;
      byKind.set(kind, entry);
    }
    for (const [kind, entry] of byKind) {
      result[`${kind}_spend`] = round(entry.spend, 2);
      result[`${kind}_cpa`] = ratio(entry.spend, entry.conversions);
      result[`${kind}_ctr`] = ratio(entry.clicks, entry.impressions);
    }
    return result;
  },
  limitations: [
    "Google: reach and frequency are not reported per campaign/day.",
    "Google: Video, Display and Demand Gen view metrics (views, view rate, viewability) are not imported.",
    "Google: Quality Score covers Search keywords only; Performance Max creative is assessed from asset group ad strength.",
  ],
};

