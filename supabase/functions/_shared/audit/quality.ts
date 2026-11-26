// Data-quality layer. Runs before any rule or score and answers, per ad
// account: which days of the audit period were actually retrieved from the
// platform, which days have metric rows, whether the numbers agree with each
// other, and how far the result can be trusted.
//
// Key distinction: a day inside a successful sync window without metric rows
// is a day with no reported delivery (Google and Meta omit rows without
// activity). A day outside every successful window is missing data, never zero.

import { addDays, daysBetweenInclusive, round } from "../format.ts";
import type {
  AccountCoverage,
  AuditAccount,
  AuditCampaign,
  AuditDailyRow,
  AuditInput,
  ConfidenceLevel,
  CoverageBasis,
  DataIssue,
  DataIssueLevel,
  DataQualityReport,
  SyncRunRecord,
} from "./types.ts";

/** Hours after which the newest successful sync is considered stale. */
export const STALE_SYNC_HOURS = 48;
/** Days after a date during which platforms commonly still restate conversions. */
export const RESTATEMENT_DAYS = 3;
/** Relative tolerance between campaign totals and daily totals. */
export const TOTALS_TOLERANCE = 0.01;

export function periodDates(start: string, end: string): string[] {
  const days = daysBetweenInclusive(start, end);
  return Array.from({ length: days }, (_, index) => addDays(start, index));
}

function dateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1] : null;
}

/** Collapses sorted dates into "a..b" ranges for messages. */
export function toRanges(dates: string[]): string[] {
  const sorted = [...dates].sort();
  const ranges: string[] = [];
  let start: string | null = null;
  let previous: string | null = null;
  for (const date of sorted) {
    if (start && previous && addDays(previous, 1) === date) {
      previous = date;
      continue;
    }
    if (start && previous) ranges.push(start === previous ? start : `${start}..${previous}`);
    start = date;
    previous = date;
  }
  if (start && previous) ranges.push(start === previous ? start : `${start}..${previous}`);
  return ranges;
}

export type AccountQuality = {
  account: AuditAccount;
  coverage: AccountCoverage;
  /** Per-date state for the audit period. */
  days: Map<string, "rows" | "zero" | "unverified" | "rows_unverified" | "missing">;
  issues: DataIssue[];
  confidence: number;
  level: ConfidenceLevel;
  components: Record<string, number>;
  /** Fields the platform could not return (e.g. Meta reach). */
  unavailableFields: string[];
  /** Daily rows for the period, de-duplicated (first row per date wins). */
  daily: AuditDailyRow[];
  campaigns: AuditCampaign[];
  lastSuccess: SyncRunRecord | null;
};

function issue(
  code: string,
  level: DataIssueLevel,
  account: AuditAccount | null,
  message: string,
  details: DataIssue["details"] = {},
  campaignId: string | null = null,
): DataIssue {
  return { code, level, adAccountId: account?.id ?? null, campaignId, message, details };
}

function closeEnough(a: number, b: number, unit: number) {
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * TOTALS_TOLERANCE + unit;
}

function confidenceLevel(value: number, hasData: boolean): ConfidenceLevel {
  if (!hasData) return "none";
  if (value >= 85) return "high";
  if (value >= 60) return "medium";
  return "low";
}

export function assessAccount(input: AuditInput, account: AuditAccount, generatedAt: string): AccountQuality {
  const issues: DataIssue[] = (input.inputIssues ?? []).filter((item) => item.adAccountId === account.id);
  const dates = periodDates(input.periodStart, input.periodEnd);
  const periodDays = dates.length;
  const campaigns = input.campaigns.filter((campaign) => campaign.adAccountId === account.id);

  // --- Campaign identifiers -------------------------------------------------
  const seen = new Set<string>();
  const seenExternal = new Map<string, string>();
  for (const campaign of campaigns) {
    if (seen.has(campaign.id)) {
      issues.push(issue("duplicate_campaign", "major", account, `Campaign "${campaign.name}" appears more than once; its totals may be double counted.`, {}, campaign.id));
    }
    seen.add(campaign.id);
    if (campaign.externalId) {
      const other = seenExternal.get(campaign.externalId);
      if (other && other !== campaign.id) {
        issues.push(issue("inconsistent_campaign_id", "major", account, `Platform campaign ID ${campaign.externalId} maps to more than one stored campaign.`, { external_id: campaign.externalId }, campaign.id));
      }
      seenExternal.set(campaign.externalId, campaign.id);
    }
    if (campaign.provider !== account.provider) {
      issues.push(issue("provider_mismatch", "blocking", account, `Campaign "${campaign.name}" is labelled ${campaign.provider} but belongs to a ${account.provider} account.`, {}, campaign.id));
    }
  }

  // --- Currency ---------------------------------------------------------------
  if (!account.currency || !/^[A-Z]{3}$/.test(account.currency)) {
    issues.push(issue("currency_unknown", "major", account, "The account currency is not known, so money values cannot be labelled or compared.", {}));
  }
  const foreign = [
    ...campaigns.map((campaign) => campaign.currency),
    ...input.daily.filter((row) => row.adAccountId === account.id).map((row) => row.currency),
  ].filter((code): code is string => typeof code === "string" && code !== "" && code !== account.currency);
  if (foreign.length > 0) {
    issues.push(issue("currency_mismatch", "blocking", account, `Some rows are in ${[...new Set(foreign)].join(", ")} instead of the account currency ${account.currency ?? "(unknown)"}; amounts in different currencies are never added.`, { currencies: [...new Set(foreign)].join(", ") }));
  }

  // --- Daily rows: duplicates, range ------------------------------------------
  const inPeriod = input.daily.filter((row) => row.adAccountId === account.id && row.date >= input.periodStart && row.date <= input.periodEnd);
  const byDate = new Map<string, AuditDailyRow>();
  let duplicates = 0;
  for (const row of [...inPeriod].sort((a, b) => a.date.localeCompare(b.date))) {
    if (byDate.has(row.date)) {
      duplicates += 1;
      continue;
    }
    byDate.set(row.date, row);
  }
  if (duplicates > 0) {
    issues.push(issue("duplicate_metric_rows", "major", account, `${duplicates} duplicate daily metric row(s) were found and ignored; totals may be overstated in the source.`, { duplicates }));
  }
  const daily = [...byDate.values()];

  for (const row of daily) {
    if (row.clicks > row.impressions && row.impressions > 0) {
      issues.push(issue("clicks_exceed_impressions", "minor", account, `On ${row.date} clicks (${row.clicks}) exceed impressions (${row.impressions}).`, { date: row.date }));
      break;
    }
  }

  // --- Totals: campaign totals vs daily totals ---------------------------------
  const campaignTotals = campaigns.reduce(
    (acc, campaign) => ({
      impressions: acc.impressions + campaign.impressions,
      clicks: acc.clicks + campaign.clicks,
      spend: acc.spend + campaign.spend,
      conversions: acc.conversions + campaign.conversions,
    }),
    { impressions: 0, clicks: 0, spend: 0, conversions: 0 },
  );
  const dailyTotals = daily.reduce(
    (acc, row) => ({
      impressions: acc.impressions + row.impressions,
      clicks: acc.clicks + row.clicks,
      spend: acc.spend + row.spend,
      conversions: acc.conversions + row.conversions,
    }),
    { impressions: 0, clicks: 0, spend: 0, conversions: 0 },
  );
  const mismatched = (["impressions", "clicks", "spend", "conversions"] as const).filter((metric) =>
    !closeEnough(campaignTotals[metric], dailyTotals[metric], metric === "spend" || metric === "conversions" ? 0.01 : 1)
  );
  if (mismatched.length > 0) {
    issues.push(issue(
      "totals_mismatch",
      "major",
      account,
      `Campaign totals and daily totals disagree for ${mismatched.join(", ")} (beyond a ${TOTALS_TOLERANCE * 100}% tolerance); the period data may be incomplete or duplicated.`,
      Object.fromEntries(mismatched.flatMap((metric) => [[`campaign_${metric}`, round(campaignTotals[metric])], [`daily_${metric}`, round(dailyTotals[metric])]])),
    ));
  }

  // --- Sync coverage ------------------------------------------------------------
  const runs = input.syncRuns?.filter((run) => run.adAccountId === account.id) ?? null;
  const successes = (runs ?? []).filter((run) => run.status === "succeeded" && run.since && run.until);
  const retrieved = new Set<string>();
  const zeroProven = new Set<string>();
  for (const run of successes) {
    for (const date of dates) {
      if (date < run.since! || date > run.until!) continue;
      retrieved.add(date);
      if (run.zeroDaysVerified) zeroProven.add(date);
    }
  }
  // Coverage basis: no successful run means only the rows themselves are known.
  const basis: CoverageBasis = runs === null || successes.length === 0
    ? "rows_only"
    : successes.every((run) => run.legacy)
    ? "legacy_sync_record"
    : "sync_record";

  // A day without rows is zero delivery only when a run proved it (complete
  // pagination, all rows stored, account totals reconciled). Otherwise it is
  // unknown: never zero.
  const days = new Map<string, "rows" | "zero" | "unverified" | "rows_unverified" | "missing">();
  for (const date of dates) {
    const hasRow = byDate.has(date);
    if (retrieved.has(date)) days.set(date, hasRow ? "rows" : zeroProven.has(date) ? "zero" : "unverified");
    else days.set(date, hasRow ? "rows_unverified" : "missing");
  }
  const missing = dates.filter((date) => days.get(date) === "missing");
  const unverified = dates.filter((date) => days.get(date) === "unverified");
  const zero = dates.filter((date) => days.get(date) === "zero");
  const sortedSuccess = [...successes].sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
  const lastSuccess = sortedSuccess[0] ?? null;
  const retrievedThrough = successes.reduce<string | null>((max, run) => (!max || run.until! > max ? run.until! : max), null);
  const lastSuccessfulSync = lastSuccess?.completedAt ?? (runs === null ? account.lastSyncedAt ?? null : null);

  const coverage: AccountCoverage = {
    periodDays,
    retrievedDays: retrieved.size,
    daysWithRows: daily.length,
    zeroDeliveryDays: zero.length,
    unverifiedDays: unverified.length,
    missingDays: missing.length,
    coverageRatio: periodDays > 0 ? round((periodDays - missing.length - unverified.length) / periodDays, 4) : 0,
    basis,
    missingRanges: toRanges(missing).slice(0, 12),
    lastSuccessfulSync,
    retrievedThrough,
  };

  if (runs !== null && successes.length === 0) {
    issues.push(issue(
      daily.length > 0 ? "no_sync_record" : "sync_never_succeeded",
      daily.length > 0 ? "major" : "blocking",
      account,
      daily.length > 0
        ? "Metric rows exist but no successful sync covering this account was found, so days without rows cannot be confirmed as zero delivery."
        : "No successful sync was found for this ad account, so its performance in the period is unknown.",
    ));
  }
  if (missing.length > 0) {
    const ratio = missing.length / Math.max(periodDays, 1);
    issues.push(issue(
      "missing_days",
      ratio > 0.5 ? "blocking" : ratio > 0.1 ? "major" : "minor",
      account,
      runs === null
        ? `${missing.length} of ${periodDays} days have no metric rows and no sync record; they are treated as unknown, not as zero.`
        : `${missing.length} of ${periodDays} days were not retrieved by any successful sync (${coverage.missingRanges.join(", ")}); they are treated as unknown, not as zero.`,
      { missing_days: missing.length, period_days: periodDays },
    ));
  }
  if (unverified.length > 0) {
    const ratio = unverified.length / Math.max(periodDays, 1);
    issues.push(issue(
      "zero_delivery_unverified",
      ratio > 0.5 ? "blocking" : ratio > 0.1 ? "major" : "minor",
      account,
      `${unverified.length} retrieved day(s) have no metric rows, but the sync could not prove that nothing was delivered on them ` +
        "(no reconciled account totals for that sync). They are treated as unknown, not as zero.",
      { unverified_days: unverified.length, period_days: periodDays },
    ));
  }
  const unresolved = Math.max(0, ...successes.map((run) => run.unresolvedCampaigns ?? 0));
  if (unresolved > 0) {
    issues.push(issue(
      "unresolved_campaigns",
      "minor",
      account,
      `${unresolved} campaign(s) had metrics but are no longer listed by the platform; their metrics are kept under a placeholder name.`,
      { campaigns: unresolved },
    ));
  }
  const unreconciled = successes.filter((run) => run.reconciliation === "mismatch");
  if (unreconciled.length > 0) {
    issues.push(issue(
      "rows_not_reconciled",
      "major",
      account,
      "The platform's account totals for a synced window differ from the stored campaign rows, so some delivery may be missing from the campaign data.",
      { windows: unreconciled.length },
    ));
  }
  if (basis === "legacy_sync_record") {
    issues.push(issue(
      "legacy_sync_record",
      "minor",
      account,
      "Coverage comes from a sync job recorded before per-account results existed (the job stored this account and no account failed). Days without rows cannot be proven to have had no delivery; re-sync to record a verified result.",
    ));
  }

  // Failures more recent than the last success that touch the period.
  for (const run of (runs ?? []).filter((item) => item.status === "failed")) {
    const overlaps = !run.since || !run.until || (run.until >= input.periodStart && run.since <= input.periodEnd);
    const newer = !lastSuccess?.completedAt || (run.completedAt ?? "") > lastSuccess.completedAt;
    if (overlaps && newer) {
      issues.push(issue(
        "sync_failed",
        missing.length > 0 ? "major" : "minor",
        account,
        `The latest sync attempt for this account failed${run.completedAt ? ` (${run.completedAt.slice(0, 16).replace("T", " ")} UTC)` : ""}: ${run.error ?? "no reason recorded"}. Earlier successful data is used where available.`,
        { failed_at: run.completedAt, legacy_job: run.legacy },
      ));
      break;
    }
  }
  const invalidValues = successes.reduce((sum, run) => sum + run.invalidValues, 0);
  if (invalidValues > 0) {
    issues.push(issue("invalid_platform_values", "major", account, `${invalidValues} metric value(s) returned by the platform were not numeric and were stored as 0.`, { values: invalidValues }));
  }
  const unavailableFields = [...new Set(successes.flatMap((run) => run.unavailableFields))].sort();
  if (unavailableFields.length > 0) {
    issues.push(issue("fields_unavailable", "minor", account, `The platform did not return ${unavailableFields.join(", ")} for this account; checks that need ${unavailableFields.length === 1 ? "it" : "them"} were skipped.`, { fields: unavailableFields.join(", ") }));
  }

  // --- Freshness ----------------------------------------------------------------
  const generated = Date.parse(generatedAt);
  if (lastSuccessfulSync && Number.isFinite(generated)) {
    const ageHours = (generated - Date.parse(lastSuccessfulSync)) / 3_600_000;
    if (ageHours > STALE_SYNC_HOURS && input.periodEnd > (retrievedThrough ?? "")) {
      issues.push(issue("stale_sync", "major", account, `The newest successful sync is ${Math.floor(ageHours / 24)} day(s) old and ends before the audit period does.`, { age_hours: Math.round(ageHours) }));
    }
    const syncedDate = dateOnly(lastSuccessfulSync);
    if (syncedDate && retrievedThrough && retrievedThrough >= input.periodEnd && daysBetweenInclusive(input.periodEnd, syncedDate) - 1 < RESTATEMENT_DAYS) {
      issues.push(issue(
        "recent_days_may_change",
        "info",
        account,
        `The last days of the period were retrieved within ${RESTATEMENT_DAYS} days of their end; platforms can still add late conversions for those days.`,
      ));
    }
  }
  if (input.periodEnd >= (dateOnly(generatedAt) ?? "9999-12-31")) {
    issues.push(issue("period_includes_today", "major", account, "The audit period includes today or future dates, which are incomplete.", {}));
  }
  if (account.syncEnabled === false) {
    issues.push(issue("sync_disabled", "minor", account, "This ad account is not selected for scheduled sync, so its data is only as current as the last manual sync.", {}));
  }
  if (account.status && !["active", "unknown"].includes(account.status)) {
    issues.push(issue("account_status", "info", account, `The platform reports this ad account as ${account.status}.`, { status: account.status }));
  }

  // --- Confidence (0-100), deterministic components -----------------------------
  const blocking = issues.filter((item) => item.level === "blocking").length;
  const major = issues.filter((item) => item.level === "major").length;
  const minor = issues.filter((item) => item.level === "minor").length;
  const withDetails = campaigns.filter((campaign) => campaign.details && Object.keys(campaign.details).length > 0).length;
  const components = {
    coverage: round(60 * coverage.coverageRatio, 1),
    verification: basis === "sync_record" ? 15 : basis === "legacy_sync_record" ? 10 : 5,
    consistency: blocking > 0 ? 0 : Math.max(0, 15 - 6 * major - 2 * minor),
    campaign_context: campaigns.length === 0 ? 0 : round((10 * withDetails) / campaigns.length, 1),
  };
  const hasData = retrieved.size > 0 || daily.length > 0;
  const confidence = hasData ? round(Object.values(components).reduce((sum, value) => sum + value, 0), 1) : 0;

  return {
    account,
    coverage,
    days,
    issues,
    confidence,
    level: confidenceLevel(confidence, hasData),
    components,
    unavailableFields,
    daily,
    campaigns,
    lastSuccess,
  };
}

export function summarizeQuality(input: AuditInput, accounts: AccountQuality[], globalIssues: DataIssue[]): DataQualityReport {
  const confidence = accounts.length === 0 ? 0 : round(accounts.reduce((sum, item) => sum + item.confidence, 0) / accounts.length, 1);
  const anyData = accounts.some((item) => item.level !== "none");
  const coverageRatio = accounts.length === 0 ? 0 : round(accounts.reduce((sum, item) => sum + item.coverage.coverageRatio, 0) / accounts.length, 4);
  const level = confidenceLevel(confidence, anyData);
  const parts = accounts.map((item) => {
    const c = item.coverage;
    const basis = c.basis === "sync_record"
      ? "per-account sync records"
      : c.basis === "legacy_sync_record"
      ? "job-level sync records (inferred)"
      : "metric rows only (no sync records)";
    return `${item.account.name}: ${c.periodDays - c.missingDays - c.unverifiedDays}/${c.periodDays} days known (${c.daysWithRows} with delivery rows, ${c.zeroDeliveryDays} proven to have no delivery, ${c.unverifiedDays} retrieved but unverified, ${c.missingDays} missing) from ${basis}`;
  });
  return {
    confidence,
    level,
    coverageRatio,
    explanation: `Period ${input.periodStart} to ${input.periodEnd}. ${parts.join("; ")}.`,
    issues: [...globalIssues, ...accounts.flatMap((item) => item.issues)],
    accounts: accounts.map((item) => ({
      adAccountId: item.account.id,
      name: item.account.name,
      confidence: item.confidence,
      level: item.level,
      coverage: item.coverage,
      components: item.components,
    })),
  };
}

export function validatePeriod(input: AuditInput): DataIssue[] {
  const issues: DataIssue[] = [];
  const days = daysBetweenInclusive(input.periodStart, input.periodEnd);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(input.periodEnd) || days <= 0) {
    throw new Error("The audit period is invalid.");
  }
  if (days > 366) throw new Error("The audit period is longer than 366 days.");
  if (days < 7) {
    issues.push({ code: "short_period", level: "minor", adAccountId: null, campaignId: null, message: `The period has only ${days} day(s); trend and sample-size based checks need at least 14.`, details: { days } });
  }
  const ids = input.accounts.map((account) => account.id);
  if (new Set(ids).size !== ids.length) throw new Error("An ad account was selected more than once.");
  return issues;
}
