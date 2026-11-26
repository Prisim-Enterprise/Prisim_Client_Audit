// PRISIM advertising audit engine 2.0.
//
// Deterministic and side-effect free: the same input (including generatedAt)
// always produces the same findings and scores. Order of work:
//   1. data quality per account (quality.ts): coverage, consistency, freshness;
//   2. rules (rules.ts), each declaring whether it had enough evidence;
//   3. scoring (scoring.ts), only where the evidence is sufficient.
// Money is never summed across different currencies. Missing data is never
// treated as zero performance.

import { daysBetweenInclusive, formatMoney, formatMultiple, formatNumber, round } from "../format.ts";
import { campaignGoal, campaignKind } from "./classify.ts";
import { assessAccount, type AccountQuality, summarizeQuality, validatePeriod } from "./quality.ts";
import { type Draft, RULES, type RuleContext, THRESHOLDS, toEvidence } from "./rules.ts";
import {
  BASIS_FACTOR,
  CATEGORY_WEIGHTS,
  combineScores,
  SCORED_CATEGORIES,
  SCORING_METHOD,
  scoreAccount,
  type ScoredFinding,
  scoreLabel,
  SEVERITY_PENALTY,
} from "./scoring.ts";
import type {
  AccountKpis,
  AccountScoring,
  AuditCampaign,
  AuditFinding,
  AuditInput,
  AuditResult,
  Benchmark,
  CampaignKpis,
  DataIssue,
  DerivedKpis,
  FindingBasis,
  FindingCategory,
  Provider,
  ScoredCategory,
  Severity,
  Totals,
} from "./types.ts";

export const ENGINE_VERSION = "prisim-audit-2.0.0";

export { BASIS_FACTOR, CATEGORY_WEIGHTS, SCORING_METHOD, scoreLabel, SEVERITY_PENALTY, THRESHOLDS };
export { scoreFindings } from "./scoring.ts";

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

/**
 * CTR benchmark for a campaign kind, only from sourced benchmarks supplied in
 * the input. The engine ships no built-in industry benchmarks.
 */
export function ctrBenchmark(benchmarks: Benchmark[], provider: Provider, kind: string): Benchmark | null {
  return benchmarks.find((item) => item.metric === "ctr" && item.provider === provider && item.kind === kind) ?? null;
}

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
  const ratio = (a: number, b: number) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a / b : null);
  const cpm = ratio(totals.spend, totals.impressions);
  return {
    ...totals,
    spend: round(totals.spend, 4),
    conversions: round(totals.conversions, 4),
    conversionValue: round(totals.conversionValue, 4),
    ctr: ratio(totals.clicks, totals.impressions),
    cpc: ratio(totals.spend, totals.clicks),
    cpm: cpm === null ? null : cpm * 1000,
    cpa: ratio(totals.spend, totals.conversions),
    conversionRate: ratio(totals.conversions, totals.clicks),
    roas: ratio(totals.conversionValue, totals.spend),
  };
}

function severityRank(severity: Severity) {
  return SEVERITY_ORDER.indexOf(severity);
}

const BASIS_RANK: Record<FindingBasis, number> = { verified: 0, target: 1, benchmark: 2, indicative: 3, unavailable: 4 };

export function sortFindings<T extends Pick<AuditFinding, "severity" | "estimatedImpact" | "title"> & { basis?: FindingBasis }>(findings: T[]): T[] {
  return [...findings].sort((a, b) =>
    severityRank(a.severity) - severityRank(b.severity)
    || BASIS_RANK[a.basis ?? "verified"] - BASIS_RANK[b.basis ?? "verified"]
    || (b.estimatedImpact ?? 0) - (a.estimatedImpact ?? 0)
    || a.title.localeCompare(b.title)
  );
}

// ---------------------------------------------------------------------------
// Data-quality findings
// ---------------------------------------------------------------------------

const ISSUE_SEVERITY: Record<DataIssue["level"], Severity> = { blocking: "high", major: "medium", minor: "low", info: "info" };
const UNAVAILABLE_CODES = new Set(["missing_days", "sync_never_succeeded", "no_sync_record", "fields_unavailable", "stale_sync", "legacy_sync_record"]);

const ISSUE_TITLES: Record<string, string> = {
  missing_days: "Part of the audit period has no retrieved data",
  sync_never_succeeded: "No successful data sync for this account",
  no_sync_record: "Data completeness cannot be confirmed",
  sync_failed: "The latest sync for this account failed",
  stale_sync: "Synced data is out of date",
  totals_mismatch: "Campaign and daily totals do not agree",
  duplicate_metric_rows: "Duplicate metric rows were found",
  duplicate_campaign: "A campaign appears more than once",
  inconsistent_campaign_id: "Inconsistent campaign identifiers",
  currency_mismatch: "Rows in different currencies",
  currency_unknown: "Account currency unknown",
  invalid_numeric_value: "Invalid numeric values in the data",
  invalid_platform_values: "Invalid values returned by the platform",
  fields_unavailable: "Some metrics were not returned by the platform",
  legacy_sync_record: "Coverage inferred from older sync records",
  recent_days_may_change: "Recent days may still change",
  period_includes_today: "The period includes incomplete days",
  sync_disabled: "Account is not selected for scheduled sync",
  account_status: "Ad account status",
  provider_mismatch: "Campaign platform does not match the account",
  clicks_exceed_impressions: "Clicks exceed impressions on some days",
  short_period: "Short audit period",
};

const ISSUE_ACTIONS: Record<string, string> = {
  missing_days: "Run a backfill sync for this account and re-run the audit before publishing.",
  sync_never_succeeded: "Check the connection and account selection, run a sync, and re-run the audit.",
  no_sync_record: "Run a sync so each day's completeness is recorded, then re-run the audit.",
  sync_failed: "Review the sync error, fix the connection or permission, and re-run the sync.",
  stale_sync: "Run a sync before publishing this audit.",
  totals_mismatch: "Re-sync the period; if the difference remains, report it to PRISIM engineering before publishing.",
  duplicate_metric_rows: "Report this to PRISIM engineering; do not publish until the source data is corrected.",
  currency_mismatch: "Audit accounts in different currencies separately; amounts were not added together.",
  legacy_sync_record: "Run a new sync so per-account results are recorded.",
  recent_days_may_change: "Re-run the audit after a few days if the most recent results matter.",
  period_includes_today: "Choose a period that ends yesterday or earlier.",
};

function issueFinding(item: DataIssue, accountProvider: Provider | null, period: { start: string; end: string; days: number }, accountName?: string): AuditFinding {
  return {
    ruleId: `data_quality.${item.code}`.slice(0, 80),
    category: "data_quality",
    severity: ISSUE_SEVERITY[item.level],
    basis: UNAVAILABLE_CODES.has(item.code) ? "unavailable" : "verified",
    platform: accountProvider,
    adAccountId: item.adAccountId,
    campaignId: item.campaignId,
    title: `${ISSUE_TITLES[item.code] ?? item.code.replace(/_/g, " ")}${accountName ? ` (${accountName})` : ""}`,
    description: item.message,
    recommendation: ISSUE_ACTIONS[item.code] ?? "Review the data before publishing.",
    evidence: {
      observed: item.details,
      thresholds: {},
      period,
      source: "sync records and stored metrics",
      unavailable: [],
      account: accountName,
    },
    estimatedImpact: null,
    estimateLabel: null,
    impactCurrency: null,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function campaignKpis(campaign: AuditCampaign, goal: CampaignKpis["goal"]): CampaignKpis {
  return {
    ...deriveKpis(campaign),
    campaignId: campaign.id,
    adAccountId: campaign.adAccountId,
    provider: campaign.provider,
    name: campaign.name,
    currency: campaign.currency ?? null,
    status: campaign.status,
    kind: campaignKind(campaign),
    goal,
    dailyBudget: campaign.dailyBudget,
  };
}

export function runAudit(input: AuditInput): AuditResult {
  if (input.accounts.length === 0) throw new Error("Select at least one ad account to audit.");
  const globalIssues = validatePeriod(input);
  const periodDays = daysBetweenInclusive(input.periodStart, input.periodEnd);
  const period = { start: input.periodStart, end: input.periodEnd, days: periodDays };
  const generatedAt = input.generatedAt ?? null;

  const accountKpis: AccountKpis[] = [];
  const qualities: AccountQuality[] = [];
  const scored: ScoredFinding[] = [];
  const accountScores: AccountScoring[] = [];
  const allCampaigns: CampaignKpis[] = [];

  for (const account of input.accounts) {
    // Freshness checks need a clock; without generatedAt they are skipped (deterministic tests).
    const quality = assessAccount(input, account, generatedAt ?? "");
    qualities.push(quality);
    const campaigns = quality.campaigns;
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
      coverage: quality.coverage,
      dataConfidence: quality.confidence,
      confidenceLevel: quality.level,
    };

    const target = input.targets?.find((item) => item.adAccountId === account.id) ?? null;
    const ctx: RuleContext = {
      input,
      period,
      account,
      kpis,
      campaigns,
      quality,
      diagnostics: input.diagnostics?.find((item) => item.adAccountId === account.id) ?? null,
      target,
      benchmarks: input.benchmarks ?? [],
    };
    for (const campaign of campaigns) allCampaigns.push(campaignKpis(campaign, campaignGoal(campaign, target ?? undefined)));

    const checks = Object.fromEntries(CATEGORIES.map((category) => [category, { applicable: [] as string[], skipped: [] as Array<{ ruleId: string; reason: string }> }])) as Record<
      FindingCategory,
      { applicable: string[]; skipped: Array<{ ruleId: string; reason: string }> }
    >;
    const accountFindings: ScoredFinding[] = [];
    const push = (draft: Draft) => {
      const finding: AuditFinding = {
        ruleId: draft.ruleId,
        category: draft.category,
        severity: draft.severity,
        basis: draft.basis,
        platform: account.provider,
        adAccountId: account.id,
        campaignId: draft.campaign?.id ?? null,
        title: draft.title,
        description: draft.description,
        recommendation: draft.recommendation,
        evidence: toEvidence(ctx, draft),
        estimatedImpact: draft.estimatedImpact ?? null,
        estimateLabel: draft.estimatedImpact ? draft.estimateLabel ?? "Estimate" : null,
        impactCurrency: draft.estimatedImpact ? account.currency : null,
      };
      const spendShare = draft.campaign && kpis.spend > 0 ? draft.campaign.spend / kpis.spend : draft.campaign ? 0 : null;
      accountFindings.push({ finding, spendShare, scoringGroup: draft.scoringGroup ?? draft.ruleId });
    };

    for (const rule of RULES) {
      const skip = rule.applies(ctx);
      if (skip !== null) {
        checks[rule.category].skipped.push({ ruleId: rule.id, reason: skip });
        continue;
      }
      checks[rule.category].applicable.push(rule.id);
      rule.run(ctx).forEach(push);
    }

    // Confirmed absence of delivery is a finding of its own (not a data gap).
    const delivered = totals.impressions > 0 || totals.spend > 0;
    const retrieved = quality.coverage.retrievedDays;
    if (!delivered && (retrieved >= THRESHOLDS.minEligibleDays || (quality.coverage.basis === "rows_only" && quality.coverage.daysWithRows > 0))) {
      push({
        ruleId: "structure.no_account_delivery",
        category: "structure",
        severity: "medium",
        basis: quality.coverage.basis === "rows_only" ? "indicative" : "verified",
        title: `No advertising delivery recorded for ${account.name}`,
        description:
          `The platform reported no impressions and no spend for any of the account's ${campaigns.length} campaign(s) on ${retrieved} retrieved day(s) ` +
          `of the ${periodDays}-day period` +
          (quality.coverage.missingDays > 0 ? `; ${quality.coverage.missingDays} day(s) were not retrieved and are unknown.` : ".") +
          " This confirms no activity, not poor performance, so the account is not scored.",
        recommendation: "Confirm with the client whether the account was meant to run in this period; if so, check campaign status, billing and policy details in the platform.",
        observed: { impressions: 0, spend: 0, campaigns: campaigns.length, enabled_campaigns: campaigns.filter((campaign) => ["ACTIVE", "ENABLED"].includes((campaign.status ?? "").toUpperCase())).length, retrieved_days: retrieved, missing_days: quality.coverage.missingDays },
        thresholds: { min_retrieved_days: THRESHOLDS.minEligibleDays },
        source: quality.coverage.basis === "rows_only" ? "stored metrics" : "sync records and stored metrics",
        unavailable: ["campaign status history during the period"],
        scoringGroup: "structure.delivery_account",
      });
    }

    for (const item of quality.issues) accountFindings.push({ finding: issueFinding(item, account.provider, period, account.name), spendShare: null, scoringGroup: item.code });

    const scoring = scoreAccount(quality, accountFindings, checks, delivered);
    accountScores.push(scoring);
    kpis.score = scoring.score;
    kpis.scoreStatus = scoring.status;
    kpis.scoreReason = scoring.reason;
    accountKpis.push(kpis);
    scored.push(...accountFindings);
  }

  for (const item of globalIssues) scored.push({ finding: issueFinding(item, null, period), spendShare: null, scoringGroup: item.code });

  const findings = sortFindings(scored.map((item) => item.finding));
  const combined = combineScores(accountScores);

  const platformScores: Partial<Record<Provider, number>> = {};
  for (const provider of ["meta", "google"] as const) {
    const items = accountScores.filter((item) => input.accounts.find((account) => account.id === item.adAccountId)?.provider === provider);
    if (items.length === 0) continue;
    const result = combineScores(items);
    if (result.overall !== null) platformScores[provider] = result.overall;
  }

  const categoryScores: Partial<Record<ScoredCategory, number>> = {};
  for (const category of SCORED_CATEGORIES) {
    const values = accountScores
      .filter((item) => item.status !== "unscored" && item.categories[category].status === "assessed")
      .map((item) => item.categories[category].score as number);
    if (values.length > 0) categoryScores[category] = round(values.reduce((sum, value) => sum + value, 0) / values.length, 1);
  }

  const currencies = new Set(input.accounts.map((account) => account.currency ?? ""));
  const singleCurrency = currencies.size === 1 ? (input.accounts[0].currency ?? null) : null;
  let totals: DerivedKpis | null = null;
  if (currencies.size === 1) {
    const sum = emptyTotals();
    accountKpis.forEach((kpis) => addTotals(sum, kpis));
    totals = deriveKpis(sum);
  }
  const dataDays = new Set(qualities.flatMap((item) => item.daily.map((row) => row.date))).size;
  const dataQuality = summarizeQuality(input, qualities, globalIssues);
  const syncs = qualities.map((item) => item.coverage.lastSuccessfulSync).filter((value): value is string => Boolean(value)).sort();
  // The oldest of the accounts' latest successful syncs: the whole audit is at least this fresh.
  const lastSuccessfulSync = syncs[0] ?? null;

  const limitations = buildLimitations(input, qualities);
  const result: AuditResult = {
    engineVersion: ENGINE_VERSION,
    overallScore: combined.overall,
    scoreStatus: combined.status,
    platformScores,
    categoryScores,
    kpis: {
      currency: singleCurrency,
      totals,
      accounts: accountKpis,
      periodDays,
      dataDays,
      campaigns: [...allCampaigns].sort((a, b) => b.spend - a.spend || b.impressions - a.impressions || a.name.localeCompare(b.name)).slice(0, 50),
      dataQuality,
      scoring: {
        status: combined.status,
        overall: combined.overall,
        reason: combined.reason,
        method: SCORING_METHOD,
        weights: CATEGORY_WEIGHTS,
        severityPenalties: SEVERITY_PENALTY,
        accounts: accountScores,
      },
      lastSuccessfulSync,
      limitations,
      metricNotes: [
        "Reach is summed from daily values and is not unique reach for the period.",
        "Conversions and conversion value are as attributed by each platform and are not de-duplicated across platforms.",
        "Meta conversions include purchases, leads and registrations only; app installs and other results are not imported.",
      ],
      ...(generatedAt ? { generatedAt } : {}),
    },
    findings,
    summary: "",
  };
  result.summary = buildSummary(input, result, findings, accountKpis, totals, singleCurrency);
  return result;
}

function buildLimitations(input: AuditInput, qualities: AccountQuality[]): string[] {
  const items = [
    "Campaign status and budgets are the values at the last sync; their history during the period is not stored.",
    "No external industry benchmarks are applied unless a sourced benchmark is listed in a finding.",
  ];
  if (!input.targets || input.targets.length === 0) items.push("No business targets (CPA, ROAS) were supplied; efficiency checks compare campaigns with the account's own averages.");
  const withoutDiagnostics = qualities.filter((item) => !input.diagnostics?.some((d) => d.adAccountId === item.account.id));
  if (withoutDiagnostics.length > 0) {
    items.push(`No diagnostics snapshot (conversion setup, ad review, Quality Score, search terms, learning status) for: ${withoutDiagnostics.map((item) => item.account.name).join(", ")}.`);
  }
  for (const diag of input.diagnostics ?? []) {
    const unavailable = Object.entries(diag.sections).filter(([, section]) => section.status === "unavailable").map(([name]) => name.replace(/_/g, " "));
    const name = qualities.find((item) => item.account.id === diag.adAccountId)?.account.name ?? diag.adAccountId;
    if (unavailable.length > 0) items.push(`${name}: not available from the platform: ${unavailable.join(", ")}.`);
    items.push(`${name}: diagnostics cover ${diag.windowStart} to ${diag.windowEnd} (captured ${diag.capturedAt.slice(0, 10)}).`);
  }
  if (qualities.some((item) => item.account.provider === "google")) {
    items.push("Google search terms exclude Performance Max; Quality Score covers Search keywords only.");
  }
  return items;
}

function buildSummary(
  input: AuditInput,
  result: AuditResult,
  findings: AuditFinding[],
  accounts: AccountKpis[],
  totals: DerivedKpis | null,
  currency: string | null,
): string {
  const parts: string[] = [];
  const accountLabel = `${accounts.length} ad account${accounts.length === 1 ? "" : "s"}`;
  parts.push(`This audit reviewed ${accountLabel} for ${input.tenantName} from ${input.periodStart} to ${input.periodEnd}.`);
  const quality = result.kpis.dataQuality!;
  parts.push(
    `Data confidence is ${quality.level} (${formatNumber(quality.confidence, 0)}/100): ${formatNumber(quality.coverageRatio * 100, 0)}% of the period's days are known` +
      (result.kpis.lastSuccessfulSync ? `, last successful sync ${result.kpis.lastSuccessfulSync.slice(0, 16).replace("T", " ")} UTC.` : "; no successful sync is recorded."),
  );
  if (result.overallScore === null) {
    parts.push(`No account health score was calculated. ${result.kpis.scoring!.reason}`);
  } else {
    const label = scoreLabel(result.overallScore).toLowerCase();
    parts.push(
      result.scoreStatus === "provisional"
        ? `The provisional account health score is ${formatNumber(result.overallScore, 0)}/100 (${label}). ${result.kpis.scoring!.reason}`
        : `The account health score is ${formatNumber(result.overallScore, 0)}/100 (${label}).`,
    );
  }
  if (totals && (totals.spend > 0 || totals.impressions > 0)) {
    parts.push(
      `Recorded spend was ${formatMoney(totals.spend, currency)} for ${formatNumber(totals.conversions, 0)} conversions` +
        (totals.cpa !== null ? ` at ${formatMoney(totals.cpa, currency)} per conversion` : "") +
        (totals.roas !== null && totals.conversionValue > 0 ? ` and ${formatMultiple(totals.roas)} reported return on ad spend` : "") +
        ".",
    );
  } else if (totals) {
    parts.push("No spend or impressions were recorded on the known days.");
  }
  const performance = findings.filter((finding) => finding.category !== "data_quality");
  const urgent = performance.filter((finding) => finding.severity === "critical" || finding.severity === "high");
  if (urgent.length > 0) {
    parts.push(`${urgent.length} high-priority finding${urgent.length === 1 ? "" : "s"}, led by: ${urgent[0].title}.`);
  } else if (performance.length > 0) {
    parts.push(`No critical or high-priority performance issues were found; ${performance.length} other finding(s) are listed.`);
  } else if (result.overallScore !== null) {
    parts.push("No performance issues were found by the checks that had enough data.");
  }
  const dataProblems = findings.filter((finding) => finding.category === "data_quality" && finding.severity !== "info" && finding.severity !== "low");
  if (dataProblems.length > 0) parts.push(`${dataProblems.length} data-quality problem(s) should be resolved before relying on this audit.`);
  const estimates = new Map<string, number>();
  for (const finding of urgent) {
    if (finding.estimatedImpact && finding.impactCurrency) estimates.set(finding.impactCurrency, (estimates.get(finding.impactCurrency) ?? 0) + finding.estimatedImpact);
  }
  if (estimates.size > 0) {
    parts.push(`Estimated spend affected by these findings: ${[...estimates.entries()].map(([code, amount]) => formatMoney(amount, code, 0)).join(" + ")} (an estimate, not a confirmed loss or saving).`);
  }
  return parts.join(" ");
}
