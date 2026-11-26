// Scoring (engine 2.1). Deterministic, explainable and per platform:
//
//   penalty(finding)  = severityPenalty[severity] x basisFactor[basis] x scope
//                       scope = 1 for account-level findings, otherwise
//                       clamp(0.35 + campaign share of account spend, 0.35, 1)
//   Within one account, findings with the same category, campaign and scoring
//   group are penalized once (the largest), and an account-level finding that
//   is explained by campaign-level findings is not penalized again.
//   category score    = max(0, 100 - sum of penalties), only for categories
//                       where at least one check had enough evidence
//   account score     = min(cap, sum(weight x category score) / sum(weight))
//                       over assessed categories, with the platform's own
//                       weights; cap = the platform's cap for the most severe
//                       VERIFIED (or target-based) finding, if any
//   platform score    = mean of that platform's scored accounts
//   overall score     = the platform score when only one platform was
//                       audited; never an average of Google and Meta
//
// Data quality is not part of the score: it is reported as confidence and
// decides whether a score is shown at all (unscored / provisional / scored).

import { round } from "../format.ts";
import type { ScoringConfig } from "./common.ts";
import { GOOGLE_FRAMEWORK } from "./google.ts";
import type { AccountQuality } from "./quality.ts";
import type {
  AccountScoring,
  AuditFinding,
  CategoryAssessment,
  FindingCategory,
  PlatformScore,
  Provider,
  ScoredCategory,
  ScoreStatus,
  Severity,
} from "./types.ts";

export const SCORED_CATEGORIES: ScoredCategory[] = ["tracking", "efficiency", "engagement", "structure", "budget", "trend"];

/** Used when no platform config is passed (e.g. tests of the arithmetic). */
export const DEFAULT_SCORING: ScoringConfig = GOOGLE_FRAMEWORK.scoring;

export const SEVERITY_PENALTY = DEFAULT_SCORING.severityPenalty;
export const BASIS_FACTOR = DEFAULT_SCORING.basisFactor;

/** Account-level findings that are not penalized when the listed campaign-level findings exist. */
export const SUPERSEDED_BY: Record<string, string[]> = {
  "efficiency.account_roas": ["efficiency.low_roas_campaign"],
};

export const MIN_COVERAGE_FOR_SCORE = 0.5;
export const FULL_COVERAGE = 0.9;
const SEVERITY_RANK: Severity[] = ["critical", "high", "medium", "low", "info"];

export const SCORING_METHOD =
  "Google Ads and Meta Ads are scored by separate frameworks with their own rules, thresholds and weights; the two scores are " +
  "never averaged. Within a platform, each area is scored only if at least one of its checks had enough data; areas without " +
  "evidence are marked not assessed and left out. Each finding subtracts its severity penalty (critical 35, high 20, medium 10, " +
  "low 4, info 0), halved for indicative and benchmark findings, and scaled by the share of spend affected for campaign-level " +
  "findings (0.35 + share, at most 1). Related findings on the same campaign are counted once. A verified critical finding caps " +
  "the account score at 59 and a verified high finding at 79. No score is given when less than half of the period's days are " +
  "known, when blocking data problems exist, when the account had no delivery, or when assessed areas carry less than 50% of the " +
  "weight. Scores are provisional when coverage is below 90%, data problems exist, data confidence is not high, completeness is " +
  "not confirmed by sync records, or assessed areas carry less than 75% of the weight.";

export type ScoredFinding = { finding: AuditFinding; spendShare: number | null; scoringGroup: string };

export function penalty(finding: Pick<AuditFinding, "severity" | "basis">, spendShare: number | null, config: ScoringConfig = DEFAULT_SCORING) {
  const base = config.severityPenalty[finding.severity] * config.basisFactor[finding.basis ?? "verified"];
  if (spendShare === null) return base;
  return base * Math.min(Math.max(0.35 + spendShare, 0.35), 1);
}

/** Category scores from findings; only categories in `assessed` (default: all) get a score. */
export function scoreFindings(
  findings: Array<{ finding: AuditFinding; spendShare: number | null; scoringGroup?: string }>,
  assessed: Set<ScoredCategory> = new Set(SCORED_CATEGORIES),
  config: ScoringConfig = DEFAULT_SCORING,
): {
  overall: number | null;
  categories: Partial<Record<ScoredCategory, number>>;
  penalties: Record<ScoredCategory, Array<{ ruleId: string; campaignId: string | null; penalty: number }>>;
  assessedWeight: number;
} {
  const present = new Set(findings.map((item) => item.finding.ruleId));
  const best = new Map<string, { ruleId: string; campaignId: string | null; category: ScoredCategory; penalty: number }>();
  for (const { finding, spendShare, scoringGroup } of findings) {
    if (finding.category === "data_quality") continue;
    const category = finding.category as ScoredCategory;
    if ((SUPERSEDED_BY[finding.ruleId] ?? []).some((ruleId) => present.has(ruleId))) continue;
    const key = `${finding.adAccountId ?? ""}|${category}|${finding.campaignId ?? "account"}|${scoringGroup ?? finding.ruleId}`;
    const value = penalty(finding, spendShare, config);
    const current = best.get(key);
    if (!current || value > current.penalty) best.set(key, { ruleId: finding.ruleId, campaignId: finding.campaignId, category, penalty: value });
  }
  const penalties = Object.fromEntries(SCORED_CATEGORIES.map((category) => [category, [] as Array<{ ruleId: string; campaignId: string | null; penalty: number }>])) as Record<
    ScoredCategory,
    Array<{ ruleId: string; campaignId: string | null; penalty: number }>
  >;
  for (const item of [...best.values()].sort((a, b) => a.ruleId.localeCompare(b.ruleId) || (a.campaignId ?? "").localeCompare(b.campaignId ?? ""))) {
    penalties[item.category].push({ ruleId: item.ruleId, campaignId: item.campaignId, penalty: round(item.penalty, 2) });
  }
  const categories: Partial<Record<ScoredCategory, number>> = {};
  let weighted = 0;
  let weight = 0;
  for (const category of SCORED_CATEGORIES) {
    if (!assessed.has(category)) continue;
    const total = penalties[category].reduce((sum, item) => sum + item.penalty, 0);
    const score = Math.max(0, 100 - total);
    categories[category] = round(score, 1);
    weighted += score * config.weights[category];
    weight += config.weights[category];
  }
  return { overall: weight > 0 ? round(weighted / weight, 1) : null, categories, penalties, assessedWeight: round(weight, 2) };
}

/** The cap from the most severe verified or target-based finding, if the platform defines one. */
export function scoreCap(findings: ScoredFinding[], config: ScoringConfig): AccountScoring["cap"] {
  let cap: AccountScoring["cap"] = null;
  for (const { finding } of findings) {
    if (finding.category === "data_quality" || (finding.basis !== "verified" && finding.basis !== "target")) continue;
    const limit = config.caps[finding.severity];
    if (limit === undefined) continue;
    if (!cap || limit < cap.limit || (limit === cap.limit && SEVERITY_RANK.indexOf(finding.severity) < SEVERITY_RANK.indexOf(cap.severity))) {
      cap = { limit, ruleId: finding.ruleId, severity: finding.severity };
    }
  }
  return cap;
}

export function scoreAccount(
  quality: AccountQuality,
  findings: ScoredFinding[],
  checks: Record<FindingCategory, { applicable: string[]; skipped: Array<{ ruleId: string; reason: string }> }>,
  delivered: boolean,
  config: ScoringConfig = DEFAULT_SCORING,
): AccountScoring {
  const assessed = new Set(SCORED_CATEGORIES.filter((category) => checks[category].applicable.length > 0));
  const result = scoreFindings(findings, assessed, config);
  const categories = Object.fromEntries(SCORED_CATEGORIES.map((category) => {
    const assessment: CategoryAssessment = {
      status: assessed.has(category) ? "assessed" : "not_assessed",
      score: result.categories[category] ?? null,
      weight: config.weights[category],
      checks: checks[category].applicable,
      skipped: checks[category].skipped,
      penalties: result.penalties[category],
      reason: assessed.has(category)
        ? `${checks[category].applicable.length} check(s) evaluated`
        : checks[category].skipped.map((item) => `${item.ruleId}: ${item.reason}`).join("; ") || "no checks apply",
    };
    return [category, assessment];
  })) as Record<ScoredCategory, CategoryAssessment>;

  const blocking = quality.issues.filter((item) => item.level === "blocking");
  const major = quality.issues.filter((item) => item.level === "major");
  const coverage = quality.coverage.coverageRatio;
  let status: ScoreStatus = "scored";
  let reason = "Sufficient evidence.";
  const provisional: string[] = [];
  if (blocking.length > 0) {
    status = "unscored";
    reason = `Blocking data problem: ${blocking[0].message}`;
  } else if (coverage < MIN_COVERAGE_FOR_SCORE) {
    status = "unscored";
    reason = `Only ${Math.round(coverage * 100)}% of the period's days are known.`;
  } else if (!delivered) {
    status = "unscored";
    reason = "No impressions or spend were recorded on the known days, so there is no performance to score.";
  } else if (result.assessedWeight < config.minAssessedWeight) {
    status = "unscored";
    reason = `Too few checks had enough data (assessed areas carry ${Math.round(result.assessedWeight * 100)}% of the weight).`;
  } else {
    if (quality.coverage.basis === "rows_only") provisional.push("completeness is not confirmed by sync records");
    if (coverage < FULL_COVERAGE) provisional.push(`${Math.round(coverage * 100)}% of the period's days are known`);
    if (major.length > 0) provisional.push(`${major.length} data problem(s)`);
    if (quality.level !== "high") provisional.push(`data confidence is ${quality.level}`);
    if (result.assessedWeight < config.fullAssessedWeight) provisional.push(`assessed areas carry ${Math.round(result.assessedWeight * 100)}% of the weight`);
    if (provisional.length > 0) {
      status = "provisional";
      reason = `Provisional: ${provisional.join("; ")}.`;
    }
  }
  const cap = status === "unscored" ? null : scoreCap(findings, config);
  const uncapped = status === "unscored" ? null : result.overall;
  const score = uncapped === null ? null : cap && uncapped > cap.limit ? cap.limit : uncapped;
  if (cap && uncapped !== null && uncapped > cap.limit) reason = `${reason} Capped at ${cap.limit} by a verified ${cap.severity} finding (${cap.ruleId}).`;
  return {
    adAccountId: quality.account.id,
    provider: quality.account.provider,
    status,
    score,
    uncappedScore: uncapped,
    cap: cap && uncapped !== null && uncapped > cap.limit ? cap : null,
    reason,
    assessedWeight: result.assessedWeight,
    categories,
  };
}

/** One platform's score from its own accounts. */
export function combinePlatform(accounts: AccountScoring[], config: ScoringConfig): PlatformScore {
  const scored = accounts.filter((item) => item.status !== "unscored" && item.score !== null);
  const base = { accounts: accounts.length, scoredAccounts: scored.length, weights: config.weights, caps: config.caps };
  if (scored.length === 0) {
    return { ...base, status: "unscored", score: null, reason: accounts.length === 1 ? accounts[0].reason : "No ad account had enough evidence for a score.", comparable: true };
  }
  const assessedSets = new Set(scored.map((item) => SCORED_CATEGORIES.filter((category) => item.categories[category].status === "assessed").join(",")));
  const comparable = assessedSets.size === 1;
  const score = round(scored.reduce((sum, item) => sum + (item.score ?? 0), 0) / scored.length, 1);
  const reasons: string[] = [];
  if (scored.length < accounts.length) reasons.push(`${accounts.length - scored.length} of ${accounts.length} account(s) could not be scored`);
  if (!comparable) reasons.push("the accounts were assessed on different areas, so their average is not like-for-like");
  reasons.push(...scored.filter((item) => item.status === "provisional").map((item) => item.reason.replace(/^Provisional: /, "").replace(/\.$/, "")));
  if (reasons.length === 0) return { ...base, status: "scored", score, reason: "All accounts had sufficient evidence.", comparable };
  return { ...base, status: "provisional", score, reason: `Provisional: ${[...new Set(reasons)].join("; ")}.`, comparable };
}

/** Status across platforms, and an overall score only when a single platform was audited. */
export function combinePlatforms(platforms: Partial<Record<Provider, PlatformScore>>): { status: ScoreStatus; overall: number | null; reason: string } {
  const entries = Object.entries(platforms) as Array<[Provider, PlatformScore]>;
  if (entries.length === 0) return { status: "unscored", overall: null, reason: "No ad account was audited." };
  const label = (provider: Provider) => (provider === "meta" ? "Meta Ads" : "Google Ads");
  if (entries.length === 1) {
    const [, platform] = entries[0];
    return { status: platform.status, overall: platform.score, reason: platform.reason };
  }
  const statuses = entries.map(([, platform]) => platform.status);
  const status: ScoreStatus = statuses.every((value) => value === "unscored")
    ? "unscored"
    : statuses.every((value) => value === "scored")
    ? "scored"
    : "provisional";
  const reason =
    "Google Ads and Meta Ads are scored separately and not combined. " +
    entries.map(([provider, platform]) => `${label(provider)}: ${platform.score === null ? "not scored" : `${platform.score}${platform.status === "provisional" ? " (provisional)" : ""}`} - ${platform.reason}`).join(" ");
  return { status, overall: null, reason };
}

export function scoreLabel(score: number): string {
  if (score >= 85) return "Strong";
  if (score >= 70) return "Healthy with gaps";
  if (score >= 50) return "Needs attention";
  return "At risk";
}
