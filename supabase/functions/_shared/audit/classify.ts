// Campaign classification shared by the rules. Every mapping here is a
// documented interpretation of platform enums, not a guess about intent:
// when the platform data does not determine the goal, the result is "unknown".

import type { AuditCampaign, BusinessTarget, CampaignGoal } from "./types.ts";

/** Google advertising_channel_type -> campaign kind. Google reports App campaigns as MULTI_CHANNEL. */
const GOOGLE_KIND: Record<string, string> = {
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

export function campaignKind(campaign: Pick<AuditCampaign, "provider" | "channelType" | "objective" | "details">): string {
  if (campaign.provider === "meta") return "meta";
  const subType = (campaign.details?.channelSubType ?? "").toUpperCase();
  if (subType.startsWith("APP_CAMPAIGN")) return "app";
  return GOOGLE_KIND[(campaign.channelType ?? campaign.objective ?? "").toUpperCase()] ?? "other";
}

export const KIND_LABEL: Record<string, string> = {
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
  meta: "Meta",
  other: "Other",
};

const GOOGLE_VALUE_BIDDING = new Set(["TARGET_ROAS", "MAXIMIZE_CONVERSION_VALUE"]);
const GOOGLE_CONVERSION_BIDDING = new Set(["TARGET_CPA", "MAXIMIZE_CONVERSIONS"]);
const GOOGLE_AWARENESS_BIDDING = new Set(["TARGET_CPM", "MANUAL_CPM", "MANUAL_CPV", "TARGET_CPV", "TARGET_IMPRESSION_SHARE", "FIXED_CPM"]);
const GOOGLE_TRAFFIC_BIDDING = new Set(["TARGET_SPEND", "MAXIMIZE_CLICKS"]);

const META_GOAL: Record<string, CampaignGoal> = {
  OUTCOME_SALES: "sales",
  CONVERSIONS: "sales",
  PRODUCT_CATALOG_SALES: "sales",
  OUTCOME_LEADS: "leads",
  LEAD_GENERATION: "leads",
  OUTCOME_APP_PROMOTION: "app",
  APP_INSTALLS: "app",
  OUTCOME_TRAFFIC: "traffic",
  LINK_CLICKS: "traffic",
  OUTCOME_AWARENESS: "awareness",
  REACH: "awareness",
  BRAND_AWARENESS: "awareness",
  VIDEO_VIEWS: "awareness",
  OUTCOME_ENGAGEMENT: "awareness",
  POST_ENGAGEMENT: "awareness",
  PAGE_LIKES: "awareness",
  EVENT_RESPONSES: "awareness",
};

/** The campaign's goal, or "unknown". A supplied account goal fills in only unknown goals. */
export function campaignGoal(campaign: AuditCampaign, target?: BusinessTarget): CampaignGoal | "unknown" {
  let goal: CampaignGoal | "unknown" = "unknown";
  if (campaign.provider === "meta") {
    goal = META_GOAL[(campaign.objective ?? "").toUpperCase()] ?? "unknown";
  } else {
    const kind = campaignKind(campaign);
    const strategy = (campaign.bidStrategy ?? "").toUpperCase();
    if (kind === "app") goal = "app";
    else if (GOOGLE_VALUE_BIDDING.has(strategy) || kind === "shopping") goal = "sales";
    else if (GOOGLE_CONVERSION_BIDDING.has(strategy)) goal = "conversions";
    else if (GOOGLE_AWARENESS_BIDDING.has(strategy)) goal = "awareness";
    else if (GOOGLE_TRAFFIC_BIDDING.has(strategy)) goal = "traffic";
    else if (kind === "pmax") goal = "conversions"; // Performance Max always bids for conversions or value.
  }
  if (goal === "unknown" && target?.goal) return target.goal;
  return goal;
}

/** Campaigns expected to produce conversions. Unknown goals are included, flagged by the caller. */
export function expectsConversions(goal: CampaignGoal | "unknown") {
  return goal === "sales" || goal === "leads" || goal === "app" || goal === "conversions" || goal === "unknown";
}

/** Campaigns expected to produce monetary conversion value. */
export function expectsRevenue(goal: CampaignGoal | "unknown") {
  return goal === "sales";
}

export const ENABLED_STATUSES = new Set(["ACTIVE", "ENABLED"]);

export function isEnabled(campaign: Pick<AuditCampaign, "status">) {
  return ENABLED_STATUSES.has((campaign.status ?? "").toUpperCase());
}

/** Meta conversions imported by the sync: purchases, leads and registrations (not app installs). */
export function conversionsImported(campaign: AuditCampaign, goal: CampaignGoal | "unknown") {
  return !(campaign.provider === "meta" && goal === "app");
}
