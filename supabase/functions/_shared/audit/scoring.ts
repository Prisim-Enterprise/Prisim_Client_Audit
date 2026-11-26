// Scoring (engine 2.0). Deterministic and explainable:
//
//   penalty(finding)  = SEVERITY_PENALTY[severity] x BASIS_FACTOR[basis] x scope
//                       scope = 1 for account-level findings, otherwise
//                       clamp(0.35 + campaign share of account spend, 0.35, 1)
//   Within one account, findings with the same category, campaign and scoring
//   group are penalized once (the largest penalty), and an account-level
//   finding that is explained by campaign-level findings is not penalized again.
//   category score    = max(0, 100 - sum of penalties), only for categories
//                       where at least one check had enough evidence
//   account score     = sum(weight x category score) / sum(weight), over
//                       assessed categories; requires assessed weight >= 0.5
//   overall score     = mean of the scored accounts' scores
//
// Data quality is not part of the score: it is reported as confidence, and it
// decides whether a score is shown at all (unscored / provisional / scored).

import { round } from "../format.ts";
import type { AccountQuality } from "./quality.ts";
import type {
  AccountScoring,
  AuditFinding,
  CategoryAssessment,
  FindingBasis,
  FindingCategory,
  ScoredCategory,
  ScoreStatus,
  Severity,
} from "./types.ts";

export const SCORED_CATEGORIES: ScoredCategory[] = ["tracking", "efficiency", "engagement", "structure", "budget", "trend"];

export const CATEGORY_WEIGHTS: Record<ScoredCategory, number> = {
  tracking: 0.26,
  efficiency: 0.26,
  engagement: 0.16,
  structure: 0.11,
  budget: 0.11,
  trend: 0.1,
};

export const SEVERITY_PENALTY: Record<Severity, number> = {
  critical: 35,
  high: 20,
  medium: 10,
  low: 4,
  info: 0,
};

/** Indicative findings count half; documented gaps do not reduce the score. */
export const BASIS_FACTOR: Record<FindingBasis, number> = {
  verified: 1,
  target: 1,
  benchmark: 0.5,
  indicative: 0.5,
  unavailable: 0,
};

/** Account-level findings that are not penalized when the listed campaign-level findings exist. */
export const SUPERSEDED_BY: Record<string, string[]> = {
  "efficiency.account_roas": ["efficiency.low_roas_campaign"],
};

export const MIN_ASSESSED_WEIGHT = 0.5;
export const FULL_ASSESSED_WEIGHT = 0.75;
export const MIN_COVERAGE_FOR_SCORE = 0.5;
export const FULL_COVERAGE = 0.9;

export const SCORING_METHOD =
  "Each performance area starts at 100 only if at least one of its checks had enough data; areas without evidence are " +
  "marked not assessed and left out. Each finding subtracts its severity penalty (critical 35, high 20, medium 10, low 4, info 0), " +
  "halved for indicative and benchmark findings, and scaled by the share of spend affected for campaign-level findings " +
  "(0.35 + share, at most 1). Related findings on the same campaign are counted once. The account score is the weighted " +
  "average of the assessed areas (tracking 26%, efficiency 26%, engagement 16%, structure 11%, budget 11%, trend 10%). " +
  "No score is given when less than half of the period's data is known, when blocking data problems exist, when the " +
  "account had no delivery, or when assessed areas carry less than 50% of the weight. Scores are provisional when " +
  "coverage is below 90%, data problems exist, data confidence is not high, or assessed areas carry less than 75% of the weight.";

export type ScoredFinding = { finding: AuditFinding; spendShare: number | null; scoringGroup: string };

export function penalty(finding: Pick<AuditFinding, "severity" | "basis">, spendShare: number | null) {
  const base = SEVERITY_PENALTY[finding.severity] * BASIS_FACTOR[finding.basis ?? "verified"];
  if (spendShare === null) return base;
  return base * Math.min(Math.max(0.35 + spendShare, 0.35), 1);
}

/** Category scores from findings; only categories in `assessed` (default: all) get a score. */
export function scoreFindings(
  findings: Array<{ finding: AuditFinding; spendShare: number | null; scoringGroup?: string }>,
  assessed: Set<ScoredCategory> = new Set(SCORED_CATEGORIES),
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
    const value = penalty(finding, spendShare);
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
    weighted += score * CATEGORY_WEIGHTS[category];
    weight += CATEGORY_WEIGHTS[category];
  }
  return { overall: weight > 0 ? round(weighted / weight, 1) : null, categories, penalties, assessedWeight: round(weight, 2) };
}

export function scoreAccount(
  quality: AccountQuality,
  findings: ScoredFinding[],
  checks: Record<FindingCategory, { applicable: string[]; skipped: Array<{ ruleId: string; reason: string }> }>,
  delivered: boolean,
): AccountScoring {
  const assessed = new Set(SCORED_CATEGORIES.filter((category) => checks[category].applicable.length > 0));
  const result = scoreFindings(findings, assessed);
  const categories = Object.fromEntries(SCORED_CATEGORIES.map((category) => {
    const assessment: CategoryAssessment = {
      status: assessed.has(category) ? "assessed" : "not_assessed",
      score: result.categories[category] ?? null,
      weight: CATEGORY_WEIGHTS[category],
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
  } else if (result.assessedWeight < MIN_ASSESSED_WEIGHT) {
    status = "unscored";
    reason = `Too few checks had enough data (assessed areas carry ${Math.round(result.assessedWeight * 100)}% of the weight).`;
  } else {
    if (quality.coverage.basis === "rows_only") provisional.push("completeness is not confirmed by sync records");
    if (coverage < FULL_COVERAGE) provisional.push(`${Math.round(coverage * 100)}% of the period's days are known`);
    if (major.length > 0) provisional.push(`${major.length} data problem(s)`);
    if (quality.level !== "high") provisional.push(`data confidence is ${quality.level}`);
    if (result.assessedWeight < FULL_ASSESSED_WEIGHT) provisional.push(`assessed areas carry ${Math.round(result.assessedWeight * 100)}% of the weight`);
    if (provisional.length > 0) {
      status = "provisional";
      reason = `Provisional: ${provisional.join("; ")}.`;
    }
  }
  return {
    adAccountId: quality.account.id,
    status,
    score: status === "unscored" ? null : result.overall,
    reason,
    assessedWeight: result.assessedWeight,
    categories,
  };
}

export function combineScores(accounts: AccountScoring[]): { status: ScoreStatus; overall: number | null; reason: string } {
  const scored = accounts.filter((item) => item.status !== "unscored" && item.score !== null);
  if (scored.length === 0) {
    return { status: "unscored", overall: null, reason: accounts.length === 1 ? accounts[0].reason : "No ad account had enough evidence for a score." };
  }
  const overall = round(scored.reduce((sum, item) => sum + (item.score ?? 0), 0) / scored.length, 1);
  const partial = scored.length < accounts.length;
  const anyProvisional = scored.some((item) => item.status === "provisional");
  if (!partial && !anyProvisional) return { status: "scored", overall, reason: "All selected accounts had sufficient evidence." };
  const reasons: string[] = [];
  if (partial) reasons.push(`${accounts.length - scored.length} of ${accounts.length} account(s) could not be scored`);
  if (anyProvisional) reasons.push(...scored.filter((item) => item.status === "provisional").map((item) => item.reason.replace(/^Provisional: /, "").replace(/\.$/, "")));
  return { status: "provisional", overall, reason: `Provisional: ${[...new Set(reasons)].join("; ")}.` };
}

export function scoreLabel(score: number): string {
  if (score >= 85) return "Strong";
  if (score >= 70) return "Healthy with gaps";
  if (score >= 50) return "Needs attention";
  return "At risk";
}
