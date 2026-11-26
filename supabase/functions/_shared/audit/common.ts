// Shared rule infrastructure: context, evidence, date eligibility, diagnostics
// access and statistics helpers. Nothing here decides what is good or bad
// performance; that lives in the platform frameworks (google.ts, meta.ts),
// each with its own classification, thresholds, rules and scoring weights.

import { daysBetweenInclusive, formatMoney } from "../format.ts";
import type { AccountQuality } from "./quality.ts";
import type {
  AccountDiagnosticsInput,
  AccountKpis,
  AuditAccount,
  AuditCampaign,
  AuditInput,
  Benchmark,
  BusinessTarget,
  CampaignDailyRow,
  FindingBasis,
  FindingCategory,
  FindingEvidence,
  Provider,
  Scalar,
  ScoredCategory,
  Severity,
} from "./types.ts";

/** Platform classification of one campaign. `goal` vocabulary is platform-specific. */
export type Classification = {
  kind: string;
  kindLabel: string;
  goal: string;
  /** The metric that counts as this campaign's result (e.g. "leads"); null = no result metric applies. */
  resultMetric: string | null;
  resultLabel: string | null;
  /** True when the classification could not be derived from platform data. */
  uncertain: boolean;
};

export type ScoringConfig = {
  weights: Record<ScoredCategory, number>;
  severityPenalty: Record<Severity, number>;
  basisFactor: Record<FindingBasis, number>;
  /** Highest account score allowed when a verified finding of this severity exists. */
  caps: Partial<Record<Severity, number>>;
  minAssessedWeight: number;
  fullAssessedWeight: number;
  method: string;
};

export type RuleContext = {
  input: AuditInput;
  period: { start: string; end: string; days: number };
  account: AuditAccount;
  kpis: AccountKpis;
  campaigns: AuditCampaign[];
  campaignDaily: CampaignDailyRow[] | null;
  quality: AccountQuality;
  diagnostics: AccountDiagnosticsInput | null;
  target: BusinessTarget | null;
  benchmarks: Benchmark[];
  classify(campaign: AuditCampaign): Classification;
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

export type PlatformFramework = {
  provider: Provider;
  label: string;
  classify(campaign: AuditCampaign, target?: BusinessTarget | null): Classification;
  rules: Rule[];
  scoring: ScoringConfig;
  thresholds: Record<string, number | string>;
  /** Account KPIs specific to the platform (e.g. Meta link CTR). */
  platformKpis(campaigns: AuditCampaign[], ctx: Pick<RuleContext, "classify" | "quality">): Record<string, number | null>;
  limitations: string[];
};

// ---------------------------------------------------------------------------

export function money(ctx: Pick<RuleContext, "account">, value: number | null) {
  return formatMoney(value, ctx.account.currency);
}

export function delivered(campaign: Pick<AuditCampaign, "impressions" | "spend">) {
  return campaign.impressions > 0 || campaign.spend > 0;
}

export const ENABLED_STATUSES = new Set(["ACTIVE", "ENABLED"]);

export function isEnabled(campaign: Pick<AuditCampaign, "status">) {
  return ENABLED_STATUSES.has((campaign.status ?? "").toUpperCase());
}

export function dateOnly(value: string | null | undefined) {
  const match = value ? /^(\d{4}-\d{2}-\d{2})/.exec(value) : null;
  return match ? match[1] : null;
}

export function ratio(numerator: number | null | undefined, denominator: number | null | undefined): number | null {
  if (numerator === null || numerator === undefined || denominator === null || denominator === undefined) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

export function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Period days the campaign could have run (from its start/end, when reported)
 * that are known for the account. "Known" excludes missing and unverified
 * days; "retrieved" counts days covered by a successful sync with rows or with
 * proven zero delivery.
 */
export function eligibleDays(ctx: Pick<RuleContext, "quality" | "period">, campaign: AuditCampaign) {
  const start = dateOnly(campaign.details?.start);
  const end = dateOnly(campaign.details?.end);
  let known = 0;
  let retrieved = 0;
  for (const [date, state] of ctx.quality.days) {
    if (start && date < start) continue;
    if (end && date > end) continue;
    if (state === "rows" || state === "zero" || state === "rows_unverified") known += 1;
    if (state === "rows" || state === "zero") retrieved += 1;
  }
  return {
    known,
    retrieved,
    start,
    end,
    scheduleKnown: Boolean(start),
    notStarted: start !== null && start > ctx.period.end,
    endedBefore: end !== null && end < ctx.period.start,
  };
}

export function diagnosticsSection(ctx: Pick<RuleContext, "diagnostics">, name: string) {
  return ctx.diagnostics?.sections[name] ?? null;
}

export function diagnosticsSource(ctx: Pick<RuleContext, "diagnostics">) {
  const d = ctx.diagnostics;
  return d ? `platform diagnostics ${d.windowStart} to ${d.windowEnd} (captured ${d.capturedAt.slice(0, 16).replace("T", " ")} UTC)` : "platform diagnostics";
}

/** True when the diagnostics window covers at least half of the audit period. */
export function diagnosticsAligned(ctx: Pick<RuleContext, "diagnostics" | "period">) {
  const d = ctx.diagnostics;
  if (!d) return false;
  const start = d.windowStart > ctx.period.start ? d.windowStart : ctx.period.start;
  const end = d.windowEnd < ctx.period.end ? d.windowEnd : ctx.period.end;
  if (end < start) return false;
  return daysBetweenInclusive(start, end) >= ctx.period.days / 2;
}

export function diagnosticsCaveat(ctx: Pick<RuleContext, "diagnostics" | "period">, truncated = false): string[] {
  const items = diagnosticsAligned(ctx) ? [] : ["diagnostics window does not match the audit period"];
  if (truncated) items.push("only the first rows of this diagnostic were read");
  return items;
}

export function statusNote(campaign: AuditCampaign) {
  const captured = campaign.details?.capturedAt ? ` at ${campaign.details.capturedAt.slice(0, 10)}` : " at the last sync";
  return `${campaign.status ?? "unknown"}${captured}`;
}

export function primaryReasons(campaign: AuditCampaign) {
  const reasons = campaign.details?.primaryStatusReasons ?? [];
  return reasons.length > 0 ? reasons.join(", ") : null;
}

/** A campaign's platform metric, or null when it was not captured for the period. */
export function platformMetric(campaign: AuditCampaign, key: string): number | null {
  const value = campaign.platformMetrics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

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

/**
 * Two equal-length halves of the period, using only known days, for one
 * group of campaigns. Uses campaign/day rows when available; otherwise the
 * account's daily rows, but only when the group is the whole account.
 */
export function groupHalves(
  ctx: RuleContext,
  campaignIds: Set<string>,
  measure: (row: { spend: number; conversions: number; impressions: number; clicks: number; platformMetrics?: Record<string, number> | null }) => { cost: number; result: number | null; impressions: number; clicks: number | null },
) {
  const dates = [...ctx.quality.days.keys()].sort();
  const size = Math.floor(dates.length / 2);
  const first = dates.slice(0, size);
  const second = dates.slice(dates.length - size);
  let rowsByDate: Map<string, Array<{ spend: number; conversions: number; impressions: number; clicks: number; platformMetrics?: Record<string, number> | null }>>;
  if (ctx.campaignDaily) {
    rowsByDate = new Map();
    for (const row of ctx.campaignDaily) {
      if (!campaignIds.has(row.campaignId)) continue;
      const list = rowsByDate.get(row.date) ?? [];
      list.push(row);
      rowsByDate.set(row.date, list);
    }
  } else if (campaignIds.size === ctx.campaigns.length) {
    rowsByDate = new Map(ctx.quality.daily.map((row) => [row.date, [row]]));
  } else {
    return null;
  }
  const sum = (part: string[]) => {
    let known = 0;
    let cost = 0;
    let result: number | null = 0;
    let impressions = 0;
    let clicks: number | null = 0;
    for (const date of part) {
      const state = ctx.quality.days.get(date);
      if (state === "missing" || state === "unverified") continue;
      known += 1;
      for (const row of rowsByDate.get(date) ?? []) {
        const value = measure(row);
        cost += value.cost;
        impressions += value.impressions;
        result = result === null || value.result === null ? null : result + value.result;
        clicks = clicks === null || value.clicks === null ? null : clicks + value.clicks;
      }
    }
    return { days: part.length, known, cost, result, impressions, clicks, from: part[0], to: part.at(-1) };
  };
  return { first: sum(first), second: sum(second) };
}
