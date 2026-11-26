// Structural checks whose mechanics are the same on every platform (delivery,
// concentration, fragmentation, volatility). Each platform framework creates
// them with its own thresholds, wording and recommendations.

import { formatMoney, formatPercent, round } from "../format.ts";
import { delivered, type Draft, eligibleDays, isEnabled, primaryReasons, type Rule, statusNote } from "./common.ts";
import type { FindingBasis, Severity } from "./types.ts";

export function noDeliveryRule(options: { minKnownDays: number; highAfterDays: number; recommendation: string; unavailableWithoutStatus?: string }): Rule {
  return {
    id: "structure.no_delivery",
    category: "structure",
    applies(ctx) {
      const enabled = ctx.campaigns.filter(isEnabled);
      if (enabled.length === 0) return "no enabled campaigns";
      return enabled.some((campaign) => eligibleDays(ctx, campaign).known >= options.minKnownDays) ? null : `fewer than ${options.minKnownDays} known days for enabled campaigns`;
    },
    run(ctx) {
      return ctx.campaigns.flatMap((campaign): Draft[] => {
        if (!isEnabled(campaign) || delivered(campaign)) return [];
        const days = eligibleDays(ctx, campaign);
        if (days.notStarted || days.endedBefore || days.known < options.minKnownDays) return [];
        // Verified only when the days were proven (sync with reconciled totals) and the schedule is known.
        const verified = days.retrieved >= options.minKnownDays && days.scheduleKnown;
        const reasons = primaryReasons(campaign);
        const unavailable = ["campaign status history during the period"];
        if (!days.scheduleKnown) unavailable.push("campaign start and end dates");
        if (!campaign.details?.primaryStatus && options.unavailableWithoutStatus) unavailable.push(options.unavailableWithoutStatus);
        if (days.retrieved < days.known) unavailable.push(`sync proof for ${days.known - days.retrieved} day(s) with account data`);
        return [{
          ruleId: "structure.no_delivery",
          category: "structure",
          severity: (verified && days.retrieved >= options.highAfterDays ? "high" : "medium") as Severity,
          basis: (verified ? "verified" : "indicative") as FindingBasis,
          campaign,
          scoringGroup: "structure.delivery",
          title: `"${campaign.name}" is enabled but delivered no impressions`,
          description:
            `No impressions or spend were recorded for this campaign on ${days.known} known day(s) of the period (${days.retrieved} proven by a reconciled sync). ` +
            `Its status is ${statusNote(campaign)}. ` +
            (days.scheduleKnown
              ? `It is scheduled from ${days.start}${days.end ? ` to ${days.end}` : ""}.`
              : "Its start date is not known, so it may not have existed for the whole period.") +
            (reasons ? ` The platform reports: ${campaign.details?.primaryStatus ?? ""} (${reasons}).` : " The reason is not reported in the synced data."),
          recommendation: options.recommendation,
          observed: {
            impressions: 0,
            spend: 0,
            known_days: days.known,
            proven_days: days.retrieved,
            status_at_sync: campaign.status,
            primary_status: campaign.details?.primaryStatus ?? null,
            primary_status_reasons: reasons,
            start: days.start,
            end: days.end,
            daily_budget: campaign.dailyBudget,
          },
          thresholds: { min_known_days: options.minKnownDays },
          unavailable,
        }];
      });
    },
  };
}

export function concentrationRule(options: { share: number; note: string }): Rule {
  return {
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
      if (share < options.share) return [];
      return [{
        ruleId: "budget.spend_concentration",
        category: "budget",
        severity: "low",
        basis: "indicative",
        campaign: top,
        scoringGroup: "budget.concentration",
        title: `${formatPercent(share, 0)} of spend runs through one campaign`,
        description: `"${top.name}" accounts for ${formatMoney(top.spend, ctx.account.currency)} of ${formatMoney(ctx.kpis.spend, ctx.account.currency)}. ${options.note}`,
        recommendation: "Keep a planned testing budget in other campaigns so alternatives are ready if the main campaign's performance changes.",
        observed: { top_campaign_share: round(share, 3), campaigns_with_spend: spending.length },
        thresholds: { concentration_share: options.share },
        unavailable: [],
      }];
    },
  };
}

export function fragmentationRule(options: { minCampaigns: number; smallShare: number; note: string }): Rule {
  return {
    id: "structure.fragmentation",
    category: "structure",
    applies(ctx) {
      return ctx.campaigns.filter((campaign) => campaign.spend > 0).length >= options.minCampaigns ? null : `fewer than ${options.minCampaigns} spending campaigns`;
    },
    run(ctx) {
      const spending = ctx.campaigns.filter((campaign) => campaign.spend > 0);
      if (ctx.kpis.spend <= 0) return [];
      const tiny = spending.filter((campaign) => campaign.spend / ctx.kpis.spend < options.smallShare);
      if (tiny.length < spending.length / 2) return [];
      return [{
        ruleId: "structure.fragmentation",
        category: "structure",
        severity: "medium",
        basis: "indicative",
        title: "Budget is spread across many small campaigns",
        description: `${tiny.length} of ${spending.length} spending campaigns each received less than ${formatPercent(options.smallShare, 0)} of spend. ${options.note}`,
        recommendation: "Consider consolidating campaigns that share a goal and audience so each has enough volume for automated bidding.",
        observed: { small_campaigns: tiny.length, campaigns_with_spend: spending.length },
        thresholds: { small_share: options.smallShare, min_campaigns: options.minCampaigns },
        unavailable: [],
      }];
    },
  };
}

export function volatilityRule(options: { minDays: number; cv: number }): Rule {
  return {
    id: "trend.spend_volatility",
    category: "trend",
    applies(ctx) {
      const days = ctx.quality.daily.filter((row) => row.spend > 0).length;
      return days >= options.minDays ? null : `fewer than ${options.minDays} days with spend`;
    },
    run(ctx) {
      // Only days with delivery: missing and unverified days are unknown, and
      // proven zero-delivery days are reported separately, not as low spend.
      const days = ctx.quality.daily.filter((row) => row.spend > 0);
      const mean = days.reduce((sum, row) => sum + row.spend, 0) / days.length;
      const variance = days.reduce((sum, row) => sum + (row.spend - mean) ** 2, 0) / days.length;
      const cv = Math.sqrt(variance) / mean;
      if (cv < options.cv) return [];
      const coverage = ctx.quality.coverage;
      return [{
        ruleId: "trend.spend_volatility",
        category: "trend",
        severity: "low",
        basis: "indicative",
        scoringGroup: "trend.volatility",
        title: "Daily spend is highly irregular",
        description:
          `On the ${days.length} days with spend, daily spend varied by ${formatPercent(cv, 0)} (coefficient of variation) around ${formatMoney(mean, ctx.account.currency)}. ` +
          `${coverage.zeroDeliveryDays} day(s) had proven zero delivery and ${coverage.missingDays + coverage.unverifiedDays} day(s) are unknown; neither is included. Planned bursts also cause this.`,
        recommendation: "If the swings are not planned, avoid large budget edits at once and check for budget caps or delivery interruptions.",
        observed: { coefficient_of_variation: round(cv, 2), average_daily_spend: round(mean), days_with_spend: days.length, zero_delivery_days: coverage.zeroDeliveryDays },
        thresholds: { cv: options.cv, min_days: options.minDays },
        unavailable: [],
      }];
    },
  };
}
