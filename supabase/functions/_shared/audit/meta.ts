// Meta Ads audit framework: Meta-specific classification, thresholds, rules
// and scoring weights. Nothing here is applied to Google accounts.
//
// Campaigns are classified by objective (and, where captured, the ad sets'
// optimization goal) into sales, leads, app promotion, traffic, engagement
// and awareness. Each is judged on its own result: purchases, leads, app
// installs or link clicks; awareness and engagement on CPM, reach and
// frequency. Purchases, leads and registrations are never added together.
// Click metrics use link clicks (inline_link_clicks), not all clicks.
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
  platformMetric,
  primaryReasons,
  ratio,
  type Rule,
  type RuleContext,
} from "./common.ts";
import { concentrationRule, fragmentationRule, noDeliveryRule, volatilityRule } from "./structural.ts";
import type { AuditCampaign, BusinessTarget, FindingBasis, Severity } from "./types.ts";

export const META_THRESHOLDS = {
  minLinkClicksForZeroResults: 100,
  minCampaignLinkClicks: 50,
  minCampaignSpendShare: 0.08,
  minResultsForCost: 5,
  minPeers: 2,
  costOutlierMultiple: 2,
  costSevereMultiple: 3,
  minPurchasesForValueCheck: 10,
  minImpressionsForCtr: 5000,
  linkCtrPeerFraction: 0.5,
  minImpressionsForCpm: 10000,
  cpmPeerMultiple: 2,
  minImpressionsForFrequency: 10000,
  frequencyHigh: 2.5,
  frequencySevere: 4,
  awarenessFrequencyHigh: 3.5,
  awarenessFrequencySevere: 5,
  underspendFraction: 0.5,
  minEligibleDays: 7,
  concentrationShare: 0.7,
  fragmentationMinCampaigns: 8,
  fragmentationSmallShare: 0.03,
  trendMinDaysPerHalf: 7,
  trendMinResultsPerHalf: 10,
  trendCostRise: 0.3,
  trendCostSevereRise: 0.6,
  fatigueCtrDrop: 0.3,
  fatigueMinImpressionsPerHalf: 5000,
  creativeMinImpressions: 5000,
  creativeMinShare: 0.1,
  creativeCtrFraction: 0.5,
  breakdownMinSpendShare: 0.15,
  breakdownCostMultiple: 2,
  volatilityMinDays: 14,
  volatilityCv: 0.6,
} as const;

const T = META_THRESHOLDS;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Objective -> family. Also used by client analytics and the analytics RPCs (keep in sync). */
export const META_OBJECTIVE_FAMILY: Record<string, string> = {
  OUTCOME_SALES: "sales",
  CONVERSIONS: "sales",
  PRODUCT_CATALOG_SALES: "sales",
  OUTCOME_LEADS: "leads",
  LEAD_GENERATION: "leads",
  OUTCOME_APP_PROMOTION: "app",
  APP_INSTALLS: "app",
  OUTCOME_TRAFFIC: "traffic",
  LINK_CLICKS: "traffic",
  OUTCOME_ENGAGEMENT: "engagement",
  POST_ENGAGEMENT: "engagement",
  PAGE_LIKES: "engagement",
  EVENT_RESPONSES: "engagement",
  MESSAGES: "engagement",
  OUTCOME_AWARENESS: "awareness",
  REACH: "awareness",
  BRAND_AWARENESS: "awareness",
  VIDEO_VIEWS: "awareness",
};

const LABEL: Record<string, string> = {
  sales: "Sales",
  leads: "Leads",
  app: "App promotion",
  traffic: "Traffic",
  engagement: "Engagement",
  awareness: "Awareness",
  unknown: "Unknown objective",
};

/** Result metric per objective family (keys of daily_metrics.platform_metrics). */
export const META_RESULT: Record<string, { metric: string; label: string } | null> = {
  sales: { metric: "purchases", label: "purchases" },
  leads: { metric: "leads", label: "leads" },
  app: { metric: "app_installs", label: "app installs" },
  traffic: { metric: "link_clicks", label: "link clicks" },
  engagement: null,
  awareness: null,
};

/** sales | leads | app | traffic | engagement | awareness | unknown */
export function metaObjectiveFamily(objective: string | null | undefined): string {
  return META_OBJECTIVE_FAMILY[(objective ?? "").toUpperCase()] ?? "unknown";
}

export function classifyMeta(campaign: AuditCampaign, target?: BusinessTarget | null): Classification {
  let family = metaObjectiveFamily(campaign.objective);
  let uncertain = false;
  if (family === "unknown") {
    uncertain = true;
    if (target?.goal && target.goal in META_RESULT) family = target.goal;
  }
  const result = META_RESULT[family] ?? null;
  return { kind: family, kindLabel: LABEL[family] ?? "Unknown objective", goal: family, resultMetric: result?.metric ?? null, resultLabel: result?.label ?? null, uncertain };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Campaign result count, or null when platform metrics were not captured. */
function results(ctx: RuleContext, campaign: AuditCampaign): number | null {
  const metric = ctx.classify(campaign).resultMetric;
  return metric ? platformMetric(campaign, metric) : null;
}

function linkClicks(campaign: AuditCampaign) {
  return platformMetric(campaign, "link_clicks");
}

/** Campaigns judged on a conversion result (purchases, leads, installs). */
function conversionFocused(ctx: RuleContext) {
  return ctx.campaigns.filter((campaign) => ["sales", "leads", "app"].includes(ctx.classify(campaign).goal));
}

function samePeers(ctx: RuleContext, campaign: AuditCampaign, filter: (peer: AuditCampaign) => boolean) {
  const family = ctx.classify(campaign).goal;
  return ctx.campaigns.filter((other) => other.id !== campaign.id && ctx.classify(other).goal === family && filter(other));
}

function adSets(ctx: RuleContext, campaign: AuditCampaign) {
  const section = diagnosticsSection(ctx, "ad_sets");
  if (section?.status !== "ok" || !campaign.externalId) return null;
  return section.rows.filter((row) => row.campaign_id === campaign.externalId);
}

function costReference(ctx: RuleContext, campaign: AuditCampaign) {
  if (ctx.target?.targetCpa && ctx.classify(campaign).goal !== "traffic") {
    return { value: ctx.target.targetCpa, label: "the target cost per result", basis: "target" as FindingBasis, peers: 0 };
  }
  const group = samePeers(ctx, campaign, (peer) => (results(ctx, peer) ?? 0) >= T.minResultsForCost);
  if (group.length < T.minPeers) return null;
  const value = median(group.map((peer) => peer.spend / (results(ctx, peer) as number)));
  return value === null ? null : { value, label: `the median of ${group.length} other ${ctx.classify(campaign).kindLabel} campaign(s)`, basis: "indicative" as FindingBasis, peers: group.length };
}

type PixelSetup = { status: "unavailable"; reason: string } | { status: "ok"; pixels: number; lastFired: string | null };

function pixelSetup(ctx: RuleContext): PixelSetup {
  const section = diagnosticsSection(ctx, "pixels");
  if (!section) return { status: "unavailable", reason: "pixels were not captured" };
  if (section.status !== "ok") return { status: "unavailable", reason: section.reason };
  const fired = section.rows.map((row) => (typeof row.last_fired_time === "string" ? row.last_fired_time : null)).filter((value): value is string => value !== null).sort();
  return { status: "ok", pixels: section.rows.length, lastFired: fired.at(-1) ?? null };
}

const unavailableResults = "result metrics per objective (synced before link clicks and results were stored; re-sync)";

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const noResults: Rule = {
  id: "tracking.no_conversions",
  category: "tracking",
  applies(ctx) {
    const relevant = conversionFocused(ctx);
    if (relevant.length === 0) return "no sales, leads or app promotion campaigns";
    if (relevant.some((campaign) => results(ctx, campaign) === null || linkClicks(campaign) === null)) return unavailableResults;
    const clicks = relevant.reduce((sum, campaign) => sum + (linkClicks(campaign) ?? 0), 0);
    return clicks >= T.minLinkClicksForZeroResults ? null : `fewer than ${T.minLinkClicksForZeroResults} link clicks on conversion-focused campaigns`;
  },
  run(ctx) {
    const drafts: Draft[] = [];
    for (const family of ["sales", "leads", "app"]) {
      const group = conversionFocused(ctx).filter((campaign) => ctx.classify(campaign).goal === family);
      if (group.length === 0) continue;
      const spend = group.reduce((sum, campaign) => sum + campaign.spend, 0);
      const clicks = group.reduce((sum, campaign) => sum + (linkClicks(campaign) ?? 0), 0);
      const count = group.reduce((sum, campaign) => sum + (results(ctx, campaign) ?? 0), 0);
      if (count > 0 || spend <= 0 || clicks < T.minLinkClicksForZeroResults) continue;
      const label = META_RESULT[family]!.label;
      const observed = { spend: round(spend), link_clicks: clicks, [label.replace(/ /g, "_")]: 0, campaigns: group.length };
      if (family === "app") {
        drafts.push({
          ruleId: "tracking.no_conversions",
          category: "tracking",
          severity: "high",
          basis: "indicative",
          title: `No app installs reported for ${group.length} app promotion campaign(s)`,
          description: `${money(ctx, spend)} and ${formatNumber(clicks)} link clicks produced 0 reported app installs. App installs are measured by the Meta SDK or a mobile measurement partner, which this audit cannot inspect.`,
          recommendation: "Confirm the app is registered with the Meta SDK or an MMP, that install events reach Events Manager, and compare with installs in the app store console.",
          observed,
          thresholds: { min_link_clicks: T.minLinkClicksForZeroResults },
          unavailable: ["app event (SDK/MMP) diagnostics"],
          estimatedImpact: round(spend),
          estimateLabel: "Spend without reported installs",
        });
        continue;
      }
      const pixel = pixelSetup(ctx);
      const inactive = pixel.status === "ok" && (pixel.pixels === 0 || !pixel.lastFired || pixel.lastFired.slice(0, 10) < ctx.period.start);
      drafts.push({
        ruleId: "tracking.no_conversions",
        category: "tracking",
        severity: inactive ? "critical" : "high",
        basis: inactive ? "verified" : "indicative",
        title: inactive ? `Meta pixel shows no activity while ${LABEL[family]} campaigns ran` : `No ${label} recorded for ${LABEL[family]} campaigns`,
        description:
          `${money(ctx, spend)} and ${formatNumber(clicks)} link clicks on ${group.length} ${LABEL[family]} campaign(s) produced 0 ${label}. ` +
          (pixel.status !== "ok"
            ? "Pixel activity could not be read, so whether tracking works is not known."
            : pixel.pixels === 0
            ? "No Meta pixel is connected to the ad account."
            : `${pixel.pixels} pixel(s) found; last activity ${pixel.lastFired ? pixel.lastFired.slice(0, 10) : "not reported"}.`) +
          (inactive ? "" : " Zero results alone does not prove that tracking is broken."),
        recommendation: "In Events Manager, confirm the pixel and Conversions API receive the optimization event, check event match quality and deduplication, and compare with the website analytics.",
        observed: pixel.status === "ok" ? { ...observed, pixels: pixel.pixels, pixel_last_fired: pixel.lastFired ? pixel.lastFired.slice(0, 10) : null } : observed,
        thresholds: { min_link_clicks: T.minLinkClicksForZeroResults },
        source: pixel.status === "ok" ? `daily metrics and ${diagnosticsSource(ctx)}` : "daily metrics",
        unavailable: [...(pixel.status === "ok" ? [] : [`pixel activity (${pixel.reason})`]), "Conversions API event diagnostics"],
        estimatedImpact: round(spend),
        estimateLabel: `Spend without recorded ${label}`,
      });
    }
    return drafts;
  },
};

const noPurchaseValue: Rule = {
  id: "tracking.no_conversion_value",
  category: "tracking",
  applies(ctx) {
    const sales = ctx.campaigns.filter((campaign) => ctx.classify(campaign).goal === "sales");
    if (sales.length === 0) return "no sales campaigns (lead, app, traffic and awareness campaigns need no purchase value)";
    if (sales.some((campaign) => platformMetric(campaign, "purchases") === null)) return unavailableResults;
    const purchases = sales.reduce((sum, campaign) => sum + (platformMetric(campaign, "purchases") ?? 0), 0);
    return purchases >= T.minPurchasesForValueCheck ? null : `fewer than ${T.minPurchasesForValueCheck} purchases`;
  },
  run(ctx) {
    const sales = ctx.campaigns.filter((campaign) => ctx.classify(campaign).goal === "sales");
    const purchases = sales.reduce((sum, campaign) => sum + (platformMetric(campaign, "purchases") ?? 0), 0);
    const value = sales.reduce((sum, campaign) => sum + (platformMetric(campaign, "purchase_value") ?? 0), 0);
    if (value > 0) return [];
    return [{
      ruleId: "tracking.no_conversion_value",
      category: "tracking",
      severity: "medium",
      basis: "verified",
      title: "Purchases are reported without purchase value",
      description: `Sales campaigns recorded ${formatNumber(purchases, 0)} purchases with no purchase value, so return on ad spend cannot be measured and value optimization is not possible.`,
      recommendation: "Send value and currency with every Purchase event (pixel and Conversions API).",
      observed: { purchases: round(purchases), purchase_value: 0 },
      thresholds: { min_purchases: T.minPurchasesForValueCheck },
      unavailable: [],
    }];
  },
};

const spendWithoutResults: Rule = {
  id: "efficiency.spend_without_conversions",
  category: "efficiency",
  applies(ctx) {
    const ok = conversionFocused(ctx).some((campaign) => results(ctx, campaign) !== null && samePeers(ctx, campaign, (peer) => (results(ctx, peer) ?? 0) > 0).length > 0);
    return ok ? null : "no conversion-focused campaign with same-objective peers that have results";
  },
  run(ctx) {
    const total = ctx.kpis.spend;
    if (total <= 0) return [];
    return conversionFocused(ctx).flatMap((campaign): Draft[] => {
      const count = results(ctx, campaign);
      const clicks = linkClicks(campaign);
      if (count === null || count > 0 || clicks === null || clicks < T.minCampaignLinkClicks || campaign.spend < total * T.minCampaignSpendShare) return [];
      const converters = samePeers(ctx, campaign, (peer) => (results(ctx, peer) ?? 0) > 0);
      if (converters.length === 0) return [];
      const { resultLabel, kindLabel } = ctx.classify(campaign);
      return [{
        ruleId: "efficiency.spend_without_conversions",
        category: "efficiency",
        severity: "high",
        basis: "verified",
        campaign,
        scoringGroup: "efficiency.campaign_return",
        title: `"${campaign.name}" spent without ${resultLabel}`,
        description: `${money(ctx, campaign.spend)} (${formatPercent(campaign.spend / total, 1)} of account spend) produced ${formatNumber(clicks)} link clicks and 0 ${resultLabel}, while ${converters.length} other ${kindLabel} campaign(s) did record ${resultLabel}.`,
        recommendation: "Review the campaign's audience, creative, landing page and the ad sets' optimization event before deciding whether to reallocate its budget.",
        observed: { spend: round(campaign.spend), spend_share: round(campaign.spend / total, 3), link_clicks: clicks, results: 0 },
        thresholds: { min_spend_share: T.minCampaignSpendShare, min_link_clicks: T.minCampaignLinkClicks },
        unavailable: [],
        estimatedImpact: round(campaign.spend),
        estimateLabel: `Spend without recorded ${resultLabel}`,
      }];
    });
  },
};

const costPerResult: Rule = {
  id: "efficiency.high_cpa_campaign",
  category: "efficiency",
  applies(ctx) {
    const ok = ctx.campaigns.some((campaign) => (results(ctx, campaign) ?? 0) >= T.minResultsForCost && costReference(ctx, campaign) !== null);
    return ok ? null : "no campaign with same-objective peers (or a target) to compare cost per result";
  },
  run(ctx) {
    return ctx.campaigns.flatMap((campaign): Draft[] => {
      const count = results(ctx, campaign);
      if (count === null || count < T.minResultsForCost || campaign.spend < ctx.kpis.spend * 0.05) return [];
      const reference = costReference(ctx, campaign);
      if (!reference) return [];
      const cost = campaign.spend / count;
      if (cost < reference.value * T.costOutlierMultiple) return [];
      const { resultLabel } = ctx.classify(campaign);
      return [{
        ruleId: "efficiency.high_cpa_campaign",
        category: "efficiency",
        severity: (cost >= reference.value * T.costSevereMultiple ? "high" : "medium") as Severity,
        basis: reference.basis,
        campaign,
        scoringGroup: "efficiency.campaign_return",
        title: `"${campaign.name}" costs ${formatMultiple(cost / reference.value, 1)} ${reference.basis === "target" ? "the target" : "its peers"} per ${resultLabel?.replace(/s$/, "")}`,
        description: `Cost per ${resultLabel?.replace(/s$/, "")} is ${money(ctx, cost)} across ${formatNumber(count, 0)} ${resultLabel}, against ${reference.label} of ${money(ctx, reference.value)}.`,
        recommendation: "Compare audience, placement and creative with the cheaper campaigns of the same objective, and test moving budget toward them.",
        observed: { cost_per_result: round(cost), results: round(count), spend: round(campaign.spend) },
        thresholds: { reference_cost: round(reference.value), multiple: T.costOutlierMultiple, peers: reference.peers },
        reference: reference.basis === "target" ? "business target cost per result supplied by PRISIM" : undefined,
        unavailable: [],
        estimatedImpact: round(Math.max(campaign.spend - count * reference.value, 0)),
        estimateLabel: "Spend above the reference cost per result (estimate)",
      }];
    });
  },
};

function purchaseRoas(campaign: AuditCampaign) {
  const value = platformMetric(campaign, "purchase_value");
  return value === null ? null : ratio(value, campaign.spend);
}

const lowRoas: Rule = {
  id: "efficiency.low_roas_campaign",
  category: "efficiency",
  applies(ctx) {
    return ctx.campaigns.some((campaign) => ctx.classify(campaign).goal === "sales" && (platformMetric(campaign, "purchase_value") ?? 0) > 0) ? null : "no sales campaigns that report purchase value";
  },
  run(ctx) {
    const targetRoas = ctx.target?.targetRoas ?? null;
    const floor = targetRoas ?? 1;
    return ctx.campaigns.flatMap((campaign): Draft[] => {
      if (ctx.classify(campaign).goal !== "sales") return [];
      const roas = purchaseRoas(campaign);
      const purchases = platformMetric(campaign, "purchases") ?? 0;
      if (roas === null || roas === 0 || purchases < T.minResultsForCost || campaign.spend < ctx.kpis.spend * 0.05 || roas >= floor) return [];
      return [{
        ruleId: "efficiency.low_roas_campaign",
        category: "efficiency",
        severity: (roas < 1 ? "high" : "medium") as Severity,
        basis: (targetRoas ? "target" : "verified") as FindingBasis,
        campaign,
        scoringGroup: "efficiency.campaign_return",
        title: `"${campaign.name}" returns ${formatMultiple(roas)} purchase value on ad spend`,
        description: `${money(ctx, platformMetric(campaign, "purchase_value"))} of attributed purchase value from ${money(ctx, campaign.spend)} of spend${targetRoas ? `, below the target ROAS of ${formatMultiple(targetRoas)}` : ""}. Attributed value is not profit.`,
        recommendation: "Check the attribution setting and the value sent with Purchase events, then review audiences and creative of this campaign.",
        observed: { purchase_roas: round(roas, 2), spend: round(campaign.spend), purchases: round(purchases) },
        thresholds: { roas_floor: floor },
        reference: targetRoas ? "business target ROAS supplied by PRISIM" : undefined,
        unavailable: ["product margins"],
        estimatedImpact: round(Math.max(campaign.spend - (platformMetric(campaign, "purchase_value") ?? 0), 0)),
        estimateLabel: "Spend above attributed value (estimate, not a loss)",
      }];
    });
  },
};

const LINK_CTR_FAMILIES = new Set(["sales", "leads", "app", "traffic"]);

function linkCtr(campaign: AuditCampaign) {
  const clicks = linkClicks(campaign);
  return clicks === null ? null : ratio(clicks, campaign.impressions);
}

const lowLinkCtr: Rule = {
  id: "engagement.low_link_ctr",
  category: "engagement",
  applies(ctx) {
    const eligible = ctx.campaigns.filter((campaign) => LINK_CTR_FAMILIES.has(ctx.classify(campaign).goal) && campaign.impressions >= T.minImpressionsForCtr);
    if (eligible.length === 0) return "no sales, leads, app or traffic campaign with enough impressions";
    if (eligible.some((campaign) => linkCtr(campaign) === null)) return "link clicks were not captured (re-sync)";
    const ok = eligible.some((campaign) => ctx.benchmarks.some((item) => item.provider === "meta" && item.kind === ctx.classify(campaign).goal) || samePeers(ctx, campaign, (peer) => peer.impressions >= T.minImpressionsForCtr && linkCtr(peer) !== null).length >= T.minPeers);
    return ok ? null : "no same-objective peers or sourced benchmark for link CTR";
  },
  run(ctx) {
    return ctx.campaigns.flatMap((campaign): Draft[] => {
      const { goal, kindLabel } = ctx.classify(campaign);
      const ctr = linkCtr(campaign);
      if (!LINK_CTR_FAMILIES.has(goal) || campaign.impressions < T.minImpressionsForCtr || ctr === null) return [];
      const benchmark = ctx.benchmarks.find((item) => item.metric === "ctr" && item.provider === "meta" && item.kind === goal);
      const peers = samePeers(ctx, campaign, (peer) => peer.impressions >= T.minImpressionsForCtr && linkCtr(peer) !== null);
      const reference = benchmark ? benchmark.value : peers.length >= T.minPeers ? median(peers.map((peer) => linkCtr(peer) as number)) : null;
      if (reference === null) return [];
      const floor = benchmark ? reference : reference * T.linkCtrPeerFraction;
      if (ctr >= floor) return [];
      return [{
        ruleId: "engagement.low_link_ctr",
        category: "engagement",
        severity: (ctr < reference / 3 ? "medium" : "low") as Severity,
        basis: benchmark ? "benchmark" : "indicative",
        campaign,
        scoringGroup: "engagement.creative",
        title: `"${campaign.name}" link click-through rate is well below ${benchmark ? "the benchmark" : `other ${kindLabel} campaigns`}`,
        description:
          `Link CTR (link clicks / impressions) is ${formatPercent(ctr)} on ${formatNumber(campaign.impressions)} impressions against ${benchmark ? `${formatPercent(reference)} (${benchmark.source}; ${benchmark.applicability})` : `a median of ${formatPercent(reference)} for ${peers.length} other ${kindLabel} campaign(s)`}. ` +
          "All-click CTR is not used because it includes reactions and profile clicks.",
        recommendation: "Test new hooks, formats and offers, and check that the audience matches the creative.",
        observed: { link_ctr: round(ctr * 100, 3), impressions: campaign.impressions, link_clicks: linkClicks(campaign) },
        thresholds: benchmark ? { benchmark_link_ctr: round(reference * 100, 3) } : { peer_median_link_ctr: round(reference * 100, 3), fraction_of_peer: T.linkCtrPeerFraction, peers: peers.length },
        reference: benchmark ? `${benchmark.source} (${benchmark.applicability})` : undefined,
        unavailable: benchmark ? [] : ["sourced external CTR benchmark"],
      }];
    });
  },
};

const highCpm: Rule = {
  id: "engagement.high_cpm",
  category: "engagement",
  applies(ctx) {
    const ok = ctx.campaigns.some((campaign) => campaign.impressions >= T.minImpressionsForCpm && samePeers(ctx, campaign, (peer) => peer.impressions >= T.minImpressionsForCpm).length >= T.minPeers);
    return ok ? null : "no campaign with same-objective peers to compare CPM";
  },
  run(ctx) {
    return ctx.campaigns.flatMap((campaign): Draft[] => {
      if (campaign.impressions < T.minImpressionsForCpm) return [];
      const peers = samePeers(ctx, campaign, (peer) => peer.impressions >= T.minImpressionsForCpm);
      if (peers.length < T.minPeers) return [];
      const cpm = (campaign.spend / campaign.impressions) * 1000;
      const reference = median(peers.map((peer) => (peer.spend / peer.impressions) * 1000));
      if (reference === null || cpm < reference * T.cpmPeerMultiple) return [];
      const { kindLabel } = ctx.classify(campaign);
      return [{
        ruleId: "engagement.high_cpm",
        category: "engagement",
        severity: "low",
        basis: "indicative",
        campaign,
        scoringGroup: "engagement.delivery_cost",
        title: `"${campaign.name}" pays ${formatMultiple(cpm / reference, 1)} the CPM of other ${kindLabel} campaigns`,
        description: `CPM is ${money(ctx, cpm)} against a median of ${money(ctx, reference)} for ${peers.length} other ${kindLabel} campaign(s). Narrow audiences, competitive placements or low-quality creative raise CPM.`,
        recommendation: "Review audience size, placements (Advantage+ placements) and creative quality for this campaign.",
        observed: { cpm: round(cpm), impressions: campaign.impressions },
        thresholds: { peer_median_cpm: round(reference), multiple: T.cpmPeerMultiple },
        unavailable: [],
      }];
    });
  },
};

const highFrequency: Rule = {
  id: "engagement.high_frequency",
  category: "engagement",
  applies(ctx) {
    if (ctx.quality.unavailableFields.includes("reach")) return "reach was not returned by Meta";
    return ctx.campaigns.some((campaign) => campaign.impressions >= T.minImpressionsForFrequency && campaign.reach > 0) ? null : "no campaign with enough impressions and reach";
  },
  run(ctx) {
    return ctx.campaigns.flatMap((campaign): Draft[] => {
      if (campaign.impressions < T.minImpressionsForFrequency || campaign.reach <= 0) return [];
      const awareness = ["awareness", "engagement"].includes(ctx.classify(campaign).goal);
      const high = awareness ? T.awarenessFrequencyHigh : T.frequencyHigh;
      const severe = awareness ? T.awarenessFrequencySevere : T.frequencySevere;
      // Reach is stored per day, so impressions / summed daily reach is the
      // average DAILY frequency; unique reach for the period is not available.
      const frequency = campaign.impressions / campaign.reach;
      if (frequency < high) return [];
      return [{
        ruleId: "engagement.high_frequency",
        category: "engagement",
        severity: (frequency >= severe ? "high" : "medium") as Severity,
        basis: "indicative",
        campaign,
        scoringGroup: "engagement.fatigue",
        title: `"${campaign.name}" shows signs of ad fatigue`,
        description: `People who saw the ads saw them ${formatNumber(frequency, 1)} times per day on average (${awareness ? "awareness/engagement" : "performance"} threshold ${high}). Check whether link CTR declined over the period.`,
        recommendation: "Rotate in new creative, broaden the audience, or use frequency caps on reach campaigns.",
        observed: { average_daily_frequency: round(frequency, 2), impressions: campaign.impressions, summed_daily_reach: campaign.reach },
        thresholds: { frequency_high: high, frequency_severe: severe },
        unavailable: ["unique reach for the whole period"],
      }];
    });
  },
};

const adReview: Rule = {
  id: "engagement.ad_review",
  category: "engagement",
  applies(ctx) {
    return diagnosticsSection(ctx, "ads")?.status === "ok" ? null : "ad status was not captured";
  },
  run(ctx) {
    const section = diagnosticsSection(ctx, "ads");
    if (section?.status !== "ok") return [];
    const byCampaign = new Map<string, { active: number; disapproved: number; issues: number }>();
    for (const row of section.rows) {
      const status = String(row.effective_status ?? "");
      if (["PAUSED", "DELETED", "ARCHIVED", "CAMPAIGN_PAUSED", "ADSET_PAUSED"].includes(status)) continue;
      const id = String(row.campaign_id ?? "");
      const entry = byCampaign.get(id) ?? { active: 0, disapproved: 0, issues: 0 };
      entry.active += 1;
      if (status === "DISAPPROVED") entry.disapproved += 1;
      if (status === "WITH_ISSUES") entry.issues += 1;
      byCampaign.set(id, entry);
    }
    return ctx.campaigns.flatMap((campaign): Draft[] => {
      if (!isEnabled(campaign) || !campaign.externalId) return [];
      const entry = byCampaign.get(campaign.externalId);
      if (!entry || entry.disapproved + entry.issues === 0) return [];
      const share = (entry.disapproved + entry.issues) / entry.active;
      return [{
        ruleId: "engagement.ad_review",
        category: "engagement",
        severity: (share >= 1 ? "high" : share >= 0.25 ? "medium" : "low") as Severity,
        basis: "verified",
        campaign,
        scoringGroup: "engagement.ad_review",
        title: `${entry.disapproved + entry.issues} of ${entry.active} ads in "${campaign.name}" are disapproved or have issues`,
        description: `At capture time: ${entry.disapproved} disapproved, ${entry.issues} with delivery issues. The status may have changed since capture.`,
        recommendation: "Open Account Quality for the disapproved ads, fix or appeal, and replace ads that cannot be approved.",
        observed: { active_ads: entry.active, disapproved: entry.disapproved, with_issues: entry.issues },
        thresholds: { any_disapproved: true },
        source: diagnosticsSource(ctx),
        unavailable: ["ad status history during the period", ...diagnosticsCaveat(ctx, section.truncated === true)],
      }];
    });
  },
};

function resultFromRow(row: Record<string, unknown>, metric: string) {
  const value = row[metric];
  return typeof value === "number" ? value : null;
}

const creativeUnderperformance: Rule = {
  id: "engagement.creative_underperformance",
  category: "engagement",
  applies(ctx) {
    const section = diagnosticsSection(ctx, "ad_performance");
    if (!section) return "ad-level performance was not captured";
    return section.status === "ok" ? null : `ad-level performance unavailable: ${section.reason}`;
  },
  run(ctx) {
    const section = diagnosticsSection(ctx, "ad_performance");
    if (section?.status !== "ok") return [];
    const drafts: Draft[] = [];
    for (const campaign of ctx.campaigns) {
      if (!campaign.externalId || !LINK_CTR_FAMILIES.has(ctx.classify(campaign).goal)) continue;
      const ads = section.rows.filter((row) => row.campaign_id === campaign.externalId && Number(row.impressions ?? 0) >= T.creativeMinImpressions && typeof row.link_clicks === "number");
      if (ads.length < 3) continue;
      const spend = ads.reduce((sum, row) => sum + Number(row.spend ?? 0), 0);
      const ctrs = ads.map((row) => Number(row.link_clicks) / Number(row.impressions));
      const typical = median(ctrs);
      if (!typical || spend <= 0) continue;
      const weak = ads.filter((row, index) => Number(row.spend ?? 0) / spend >= T.creativeMinShare && ctrs[index] < typical * T.creativeCtrFraction);
      if (weak.length === 0) continue;
      const weakSpend = weak.reduce((sum, row) => sum + Number(row.spend ?? 0), 0);
      drafts.push({
        ruleId: "engagement.creative_underperformance",
        category: "engagement",
        severity: "low",
        basis: "indicative",
        campaign,
        scoringGroup: "engagement.creative",
        title: `${weak.length} ad(s) in "${campaign.name}" take ${formatPercent(weakSpend / spend, 0)} of its spend with half the typical link CTR`,
        description: `Examples: ${weak.slice(0, 3).map((row) => `"${String(row.ad_name ?? row.ad_id)}" (${formatPercent(Number(row.link_clicks) / Number(row.impressions))} link CTR)`).join(", ")}; median link CTR across ${ads.length} ads is ${formatPercent(typical)}.`,
        recommendation: "Pause or replace the weakest creative once the stronger variants have enough delivery to confirm the difference.",
        observed: { ads_compared: ads.length, weak_ads: weak.length, weak_spend_share: round(weakSpend / spend, 3) },
        thresholds: { min_spend_share: T.creativeMinShare, ctr_fraction_of_median: T.creativeCtrFraction },
        source: diagnosticsSource(ctx),
        unavailable: diagnosticsCaveat(ctx, section.truncated === true),
      });
    }
    return drafts;
  },
};

function breakdownRule(id: "engagement.placement_cost" | "engagement.audience_cost", sectionName: string, describe: (row: Record<string, unknown>) => string, what: string): Rule {
  const singleFamily = (ctx: RuleContext) => {
    const families = new Set(ctx.campaigns.filter(delivered).map((campaign) => ctx.classify(campaign).goal));
    const [family] = [...families];
    return families.size === 1 && META_RESULT[family] ? family : null;
  };
  return {
    id,
    category: "engagement",
    applies(ctx) {
      const section = diagnosticsSection(ctx, sectionName);
      if (!section) return `${what} breakdown was not captured`;
      if (section.status !== "ok") return `${what} breakdown unavailable: ${section.reason}`;
      // Breakdowns are account-level, so results are only comparable when all delivering campaigns share one objective.
      return singleFamily(ctx) ? null : "delivering campaigns have different objectives, so account-level breakdowns mix results";
    },
    run(ctx) {
      const section = diagnosticsSection(ctx, sectionName);
      const family = singleFamily(ctx);
      if (section?.status !== "ok" || !family) return [];
      const metric = META_RESULT[family]!.metric;
      const rows = section.rows.map((row) => ({ label: describe(row), spend: Number(row.spend ?? 0), result: resultFromRow(row, metric) }));
      if (rows.some((row) => row.result === null)) return [];
      const spend = rows.reduce((sum, row) => sum + row.spend, 0);
      const total = rows.reduce((sum, row) => sum + (row.result ?? 0), 0);
      if (spend <= 0 || total < T.minResultsForCost) return [];
      const average = spend / total;
      const costly = rows.filter((row) => row.spend / spend >= T.breakdownMinSpendShare && (row.result === 0 || row.spend / (row.result as number) >= average * T.breakdownCostMultiple));
      return costly.map((row): Draft => ({
        ruleId: id,
        category: "engagement",
        severity: "low",
        basis: "indicative",
        scoringGroup: id,
        title: `${row.label} takes ${formatPercent(row.spend / spend, 0)} of spend at ${row.result === 0 ? "no" : `${formatMultiple(row.spend / (row.result as number) / average, 1)} the average`} cost per ${META_RESULT[family]!.label.replace(/s$/, "")}`,
        description: `${money(ctx, row.spend)} produced ${formatNumber(row.result, 0)} ${META_RESULT[family]!.label}; the account average is ${money(ctx, average)} per result. Meta's delivery may still value this ${what} for reach or assisted results.`,
        recommendation: what === "placement"
          ? "Review creative fit for this placement (format and aspect ratio) before excluding it; exclusions can raise costs elsewhere."
          : "Check whether this audience segment fits the offer; adjust creative or exclude it only if the gap persists.",
        observed: { segment: row.label, spend: round(row.spend), results: round(row.result as number), spend_share: round(row.spend / spend, 3) },
        thresholds: { min_spend_share: T.breakdownMinSpendShare, cost_multiple: T.breakdownCostMultiple },
        source: diagnosticsSource(ctx),
        unavailable: diagnosticsCaveat(ctx, section.truncated === true),
      }));
    },
  };
}

const learningLimited: Rule = {
  id: "structure.learning_limited",
  category: "structure",
  applies(ctx) {
    const section = diagnosticsSection(ctx, "ad_sets");
    if (section?.status !== "ok") return "ad set learning status was not captured";
    return section.rows.some((row) => typeof row.learning_status === "string") ? null : "Meta returned no learning status (only for active, non-dynamic-creative ad sets)";
  },
  run(ctx) {
    return ctx.campaigns.flatMap((campaign): Draft[] => {
      const sets = (adSets(ctx, campaign) ?? []).filter((row) => row.effective_status === "ACTIVE" && typeof row.learning_status === "string");
      const failed = sets.filter((row) => row.learning_status === "FAIL");
      if (!delivered(campaign) || failed.length === 0) return [];
      const goals = [...new Set(failed.map((row) => String(row.optimization_goal ?? "unknown")))];
      return [{
        ruleId: "structure.learning_limited",
        category: "structure",
        severity: (failed.length === sets.length ? "medium" : "low") as Severity,
        basis: "verified",
        campaign,
        scoringGroup: "structure.learning",
        title: `${failed.length} of ${sets.length} active ad sets in "${campaign.name}" are learning limited`,
        description: `Meta reports learning status FAIL for ad sets optimizing for ${goals.join(", ")}: they are not generating enough of that optimization event to exit learning. The relevant event is the optimization goal, not the results shown elsewhere in this audit.`,
        recommendation: "Consolidate ad sets with the same optimization goal, broaden audiences, or optimize for a more frequent event until volume is sufficient.",
        observed: { active_ad_sets_with_status: sets.length, learning_limited: failed.length, optimization_goals: goals.join(", ") },
        thresholds: { learning_status: "FAIL" },
        source: diagnosticsSource(ctx),
        unavailable: ["learning status history during the period", ...diagnosticsCaveat(ctx)],
      }];
    });
  },
};

const UPPER_FUNNEL = new Set(["LINK_CLICKS", "LANDING_PAGE_VIEWS", "IMPRESSIONS", "REACH", "POST_ENGAGEMENT", "THRUPLAY"]);

const optimizationMismatch: Rule = {
  id: "structure.optimization_mismatch",
  category: "structure",
  applies(ctx) {
    if (conversionFocused(ctx).length === 0) return "no sales, leads or app promotion campaigns";
    return diagnosticsSection(ctx, "ad_sets")?.status === "ok" ? null : "ad set optimization goals were not captured";
  },
  run(ctx) {
    return conversionFocused(ctx).flatMap((campaign): Draft[] => {
      const sets = (adSets(ctx, campaign) ?? []).filter((row) => row.effective_status === "ACTIVE");
      const upper = sets.filter((row) => UPPER_FUNNEL.has(String(row.optimization_goal)));
      if (!delivered(campaign) || sets.length === 0 || upper.length === 0) return [];
      const { kindLabel, resultLabel } = ctx.classify(campaign);
      return [{
        ruleId: "structure.optimization_mismatch",
        category: "structure",
        severity: "low",
        basis: "indicative",
        campaign,
        scoringGroup: "structure.optimization",
        title: `${upper.length} active ad set(s) in the ${kindLabel} campaign "${campaign.name}" optimize for an upper-funnel event`,
        description: `They optimize for ${[...new Set(upper.map((row) => String(row.optimization_goal)))].join(", ")} although the campaign is judged on ${resultLabel}. This can be deliberate while conversion volume is low.`,
        recommendation: "Once the conversion event has enough volume, test optimizing these ad sets for the conversion event itself.",
        observed: { active_ad_sets: sets.length, upper_funnel_ad_sets: upper.length },
        thresholds: { upper_funnel_goals: [...UPPER_FUNNEL].join(", ") },
        source: diagnosticsSource(ctx),
        unavailable: diagnosticsCaveat(ctx),
      }];
    });
  },
};

/** Campaign budget (CBO) or the sum of active ad set daily budgets (ABO). */
function campaignBudget(ctx: RuleContext, campaign: AuditCampaign): { amount: number; source: string } | null {
  if (campaign.dailyBudget && campaign.dailyBudget > 0) return { amount: campaign.dailyBudget, source: "campaign daily budget (Advantage campaign budget) at last sync" };
  if (campaign.details?.budgetLevel !== "ad_set") return null;
  const sets = (adSets(ctx, campaign) ?? []).filter((row) => row.effective_status === "ACTIVE" && typeof row.daily_budget === "number");
  const total = sets.reduce((sum, row) => sum + Number(row.daily_budget), 0);
  return total > 0 ? { amount: total, source: `sum of ${sets.length} active ad set daily budgets at capture` } : null;
}

const underspend: Rule = {
  id: "budget.underspend",
  category: "budget",
  applies(ctx) {
    const ok = ctx.campaigns.some((campaign) => isEnabled(campaign) && delivered(campaign) && campaignBudget(ctx, campaign) && eligibleDays(ctx, campaign).known >= T.minEligibleDays);
    return ok ? null : "no active, delivering campaign with a known daily budget";
  },
  run(ctx) {
    return ctx.campaigns.flatMap((campaign): Draft[] => {
      if (!isEnabled(campaign) || !delivered(campaign)) return [];
      const budget = campaignBudget(ctx, campaign);
      const days = eligibleDays(ctx, campaign);
      if (!budget || days.known < T.minEligibleDays) return [];
      const average = campaign.spend / days.known;
      if (average >= budget.amount * T.underspendFraction) return [];
      const unavailable = ["budget changes during the period"];
      if (!days.scheduleKnown) unavailable.push("campaign start and end dates");
      return [{
        ruleId: "budget.underspend",
        category: "budget",
        severity: "low",
        basis: "indicative",
        campaign,
        scoringGroup: "budget.utilization",
        title: `"${campaign.name}" spends well below its daily budget`,
        description:
          `Average spend per known day was ${money(ctx, average)} over ${days.known} day(s), ${formatPercent(average / budget.amount, 0)} of ${money(ctx, budget.amount)} (${budget.source}). ` +
          "The budget may have changed during the period; the cause is not determined by this data (bid or cost caps, small audiences, ad review and schedules are common causes).",
        recommendation: "Check the delivery column and ad set details in Ads Manager, and either address the limiting factor or lower the budget.",
        observed: { average_daily_spend: round(average), daily_budget: round(budget.amount), known_days: days.known, primary_status_reasons: primaryReasons(campaign) },
        thresholds: { min_utilization: T.underspendFraction },
        unavailable,
      }];
    });
  },
};

function trendGroups(ctx: RuleContext) {
  const groups: Array<{ family: string; metric: string; halves: NonNullable<ReturnType<typeof groupHalves>> }> = [];
  for (const family of ["sales", "leads", "app"]) {
    const campaigns = ctx.campaigns.filter((campaign) => ctx.classify(campaign).goal === family);
    if (campaigns.length === 0) continue;
    const metric = META_RESULT[family]!.metric;
    const halves = groupHalves(ctx, new Set(campaigns.map((campaign) => campaign.id)), (row) => ({
      cost: row.spend,
      result: row.platformMetrics && typeof row.platformMetrics[metric] === "number" ? row.platformMetrics[metric] : null,
      impressions: row.impressions,
      clicks: row.platformMetrics && typeof row.platformMetrics.link_clicks === "number" ? row.platformMetrics.link_clicks : null,
    }));
    if (!halves || halves.first.result === null || halves.second.result === null) continue;
    if (halves.first.known < T.trendMinDaysPerHalf || halves.second.known < T.trendMinDaysPerHalf) continue;
    if (halves.first.known < halves.first.days * 0.8 || halves.second.known < halves.second.days * 0.8) continue;
    if (halves.first.result < T.trendMinResultsPerHalf || halves.second.result < T.trendMinResultsPerHalf) continue;
    groups.push({ family, metric, halves });
  }
  return groups;
}

const costTrend: Rule = {
  id: "trend.cpa_rising",
  category: "trend",
  applies(ctx) {
    return trendGroups(ctx).length > 0 ? null : `no objective with campaign/day results and ${T.trendMinResultsPerHalf}+ results in each half`;
  },
  run(ctx) {
    return trendGroups(ctx).flatMap(({ family, metric, halves }): Draft[] => {
      const before = halves.first.cost / (halves.first.result as number);
      const after = halves.second.cost / (halves.second.result as number);
      if (after < before * (1 + T.trendCostRise)) return [];
      const label = META_RESULT[family]!.label;
      return [{
        ruleId: "trend.cpa_rising",
        category: "trend",
        severity: after >= before * (1 + T.trendCostSevereRise) ? "high" : "medium",
        basis: "verified",
        scoringGroup: `trend.cost.${family}`,
        title: `${LABEL[family]} cost per ${label.replace(/s$/, "")} rose ${formatPercent(after / before - 1, 0)} between the two halves of the period`,
        description: `It was ${money(ctx, before)} from ${halves.first.from} to ${halves.first.to} and ${money(ctx, after)} from ${halves.second.from} to ${halves.second.to}. Recent days can still gain attributed results.`,
        recommendation: "Look for creative fatigue, audience saturation, auction competition or budget increases in the second half of the period.",
        observed: { objective: LABEL[family], [`cost_per_${metric}_first_half`]: round(before), [`cost_per_${metric}_second_half`]: round(after) },
        thresholds: { rise: T.trendCostRise, min_results_per_half: T.trendMinResultsPerHalf },
        unavailable: [],
        estimatedImpact: round(Math.max(halves.second.cost - (halves.second.result as number) * before, 0)),
        estimateLabel: "Second-half spend above the first-half cost per result (estimate)",
      }];
    });
  },
};

const creativeFatigue: Rule = {
  id: "trend.creative_fatigue",
  category: "trend",
  applies(ctx) {
    if (!ctx.campaignDaily) return "campaign/day rows were not provided";
    return ctx.campaigns.some((campaign) => LINK_CTR_FAMILIES.has(ctx.classify(campaign).goal) && linkClicks(campaign) !== null && campaign.impressions >= 2 * T.fatigueMinImpressionsPerHalf)
      ? null
      : "no campaign with link clicks and enough impressions in both halves";
  },
  run(ctx) {
    return ctx.campaigns.flatMap((campaign): Draft[] => {
      if (!LINK_CTR_FAMILIES.has(ctx.classify(campaign).goal) || linkClicks(campaign) === null) return [];
      const halves = groupHalves(ctx, new Set([campaign.id]), (row) => ({
        cost: row.spend,
        result: null,
        impressions: row.impressions,
        clicks: row.platformMetrics && typeof row.platformMetrics.link_clicks === "number" ? row.platformMetrics.link_clicks : null,
      }));
      if (!halves || halves.first.clicks === null || halves.second.clicks === null) return [];
      if (halves.first.impressions < T.fatigueMinImpressionsPerHalf || halves.second.impressions < T.fatigueMinImpressionsPerHalf) return [];
      const before = halves.first.clicks / halves.first.impressions;
      const after = halves.second.clicks / halves.second.impressions;
      if (before <= 0 || after >= before * (1 - T.fatigueCtrDrop)) return [];
      return [{
        ruleId: "trend.creative_fatigue",
        category: "trend",
        severity: "low",
        basis: "indicative",
        campaign,
        scoringGroup: "trend.fatigue",
        title: `"${campaign.name}" link CTR fell ${formatPercent(1 - after / before, 0)} between the two halves of the period`,
        description: `Link CTR was ${formatPercent(before)} from ${halves.first.from} to ${halves.first.to} and ${formatPercent(after)} from ${halves.second.from} to ${halves.second.to}. A falling CTR with stable targeting usually means the creative is wearing out.`,
        recommendation: "Introduce new creative variations and check frequency for this campaign.",
        observed: { link_ctr_first_half: round(before * 100, 3), link_ctr_second_half: round(after * 100, 3) },
        thresholds: { ctr_drop: T.fatigueCtrDrop, min_impressions_per_half: T.fatigueMinImpressionsPerHalf },
        unavailable: ["ad-level daily trends"],
      }];
    });
  },
};

// ---------------------------------------------------------------------------
// Framework
// ---------------------------------------------------------------------------

function sumMetric(campaigns: AuditCampaign[], key: string): number | null {
  let total = 0;
  for (const campaign of campaigns) {
    if (!delivered(campaign)) continue;
    const value = platformMetric(campaign, key);
    if (value === null) return null;
    total += value;
  }
  return total;
}

export const META_FRAMEWORK: PlatformFramework = {
  provider: "meta",
  label: "Meta Ads",
  classify: classifyMeta,
  thresholds: META_THRESHOLDS,
  rules: [
    noResults,
    noPurchaseValue,
    spendWithoutResults,
    costPerResult,
    lowRoas,
    lowLinkCtr,
    highCpm,
    highFrequency,
    adReview,
    creativeUnderperformance,
    breakdownRule("engagement.placement_cost", "placements", (row) => `${String(row.publisher_platform ?? "?")} ${String(row.platform_position ?? "")}`.trim(), "placement"),
    breakdownRule("engagement.audience_cost", "audiences", (row) => `Age ${String(row.age ?? "?")}, ${String(row.gender ?? "?")}`, "audience"),
    learningLimited,
    optimizationMismatch,
    noDeliveryRule({
      minKnownDays: T.minEligibleDays,
      highAfterDays: 14,
      recommendation: "Check the campaign's delivery column in Ads Manager for ad set or ad issues, billing, audience size and schedule; pause it if it is no longer needed.",
    }),
    fragmentationRule({ minCampaigns: T.fragmentationMinCampaigns, smallShare: T.fragmentationSmallShare, note: "Thin budgets keep ad sets in the learning phase. Separate campaigns can be intentional (markets, catalogs)." }),
    underspend,
    concentrationRule({ share: T.concentrationShare, note: "This can be intentional, but results depend heavily on one campaign." }),
    costTrend,
    creativeFatigue,
    volatilityRule({ minDays: T.volatilityMinDays, cv: T.volatilityCv }),
  ],
  scoring: {
    // Meta: creative, frequency and delivery cost (engagement) and learning /
    // optimization setup (structure) weigh more than on Google; budget less.
    weights: { tracking: 0.2, efficiency: 0.25, engagement: 0.25, structure: 0.15, budget: 0.05, trend: 0.1 },
    severityPenalty: { critical: 35, high: 20, medium: 10, low: 4, info: 0 },
    basisFactor: { verified: 1, target: 1, benchmark: 0.5, indicative: 0.5, unavailable: 0 },
    caps: { critical: 59, high: 79 },
    minAssessedWeight: 0.5,
    fullAssessedWeight: 0.75,
    method:
      "Meta Ads score: areas are weighted tracking 20%, efficiency 25%, engagement 25%, structure 15%, budget 5%, trend 10%. " +
      "Results are judged per objective (purchases, leads, installs, link clicks). A verified critical finding caps the account score at 59, a verified high finding at 79.",
  },
  platformKpis(campaigns) {
    const spend = campaigns.reduce((sum, campaign) => sum + campaign.spend, 0);
    const impressions = campaigns.reduce((sum, campaign) => sum + campaign.impressions, 0);
    const reach = campaigns.reduce((sum, campaign) => sum + campaign.reach, 0);
    const links = sumMetric(campaigns, "link_clicks");
    const purchases = sumMetric(campaigns.filter((campaign) => classifyMeta(campaign).goal === "sales"), "purchases");
    const purchaseValue = sumMetric(campaigns.filter((campaign) => classifyMeta(campaign).goal === "sales"), "purchase_value");
    const salesSpend = campaigns.filter((campaign) => classifyMeta(campaign).goal === "sales").reduce((sum, campaign) => sum + campaign.spend, 0);
    const leadCampaigns = campaigns.filter((campaign) => classifyMeta(campaign).goal === "leads");
    const appCampaigns = campaigns.filter((campaign) => classifyMeta(campaign).goal === "app");
    const leads = sumMetric(leadCampaigns, "leads");
    const installs = sumMetric(appCampaigns, "app_installs");
    return {
      link_clicks: links,
      link_ctr: ratio(links, impressions),
      cost_per_link_click: ratio(spend, links),
      cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
      average_daily_frequency: reach > 0 ? impressions / reach : null,
      purchases,
      cost_per_purchase: ratio(salesSpend, purchases),
      purchase_roas: ratio(purchaseValue, salesSpend),
      leads,
      cost_per_lead: ratio(leadCampaigns.reduce((sum, campaign) => sum + campaign.spend, 0), leads),
      app_installs: installs,
      cost_per_install: ratio(appCampaigns.reduce((sum, campaign) => sum + campaign.spend, 0), installs),
    };
  },
  limitations: [
    "Meta: clicks, CTR and CPC in the totals are all clicks; link CTR and cost per link click are shown separately.",
    "Meta: reach is summed from daily values (average daily frequency), not unique reach for the period.",
    "Meta: Conversions API event quality and app SDK events are not inspected.",
  ],
};
