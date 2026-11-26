// Maps database rows (get_campaign_performance / get_daily_performance,
// ad_accounts, campaigns.details, sync_jobs, ad_account_diagnostics) to the
// engine input. Shared by the run-audit Edge Function and demo mode.
//
// Values that are present but not numeric are never silently turned into 0:
// they are counted as data-quality issues (the numeric field is then 0 so
// arithmetic stays defined, and the audit cannot be fully scored).

import type {
  AccountDiagnosticsInput,
  AuditAccount,
  AuditCampaign,
  AuditDailyRow,
  AuditInput,
  Benchmark,
  BusinessTarget,
  CampaignContext,
  DataIssue,
  DiagnosticSectionInput,
  Provider,
  SyncRunRecord,
} from "./types.ts";

export type CampaignPerformanceRow = {
  campaign_id: string;
  ad_account_id: string;
  provider: string;
  account_name: string | null;
  external_campaign_id: string;
  campaign_name: string | null;
  objective: string | null;
  campaign_status: string | null;
  channel_type: string | null;
  bid_strategy: string | null;
  daily_budget: number | string | null;
  currency: string | null;
  impressions: number | string;
  reach: number | string;
  clicks: number | string;
  spend: number | string;
  conversions: number | string;
  conversion_value: number | string;
  active_days: number | string;
};

export type DailyPerformanceRow = {
  metric_date: string;
  ad_account_id: string;
  provider: string;
  currency: string | null;
  impressions: number | string;
  reach: number | string;
  clicks: number | string;
  spend: number | string;
  conversions: number | string;
  conversion_value: number | string;
};

export type AccountRow = {
  id: string;
  provider: string;
  account_name: string | null;
  external_account_id: string;
  currency: string | null;
  connection_id?: string | null;
  status?: string | null;
  timezone?: string | null;
  sync_enabled?: boolean | null;
  last_synced_at?: string | null;
};

/** public.campaigns (id, details) for the selected accounts. */
export type CampaignDetailsRow = { id: string; details: Record<string, unknown> | null };

/** public.sync_jobs rows (staff-only) for the tenant. */
export type SyncJobRow = {
  id: string;
  connection_id: string | null;
  job_type: string;
  status: string;
  completed_at: string | null;
  error_message: string | null;
  stats: Record<string, unknown> | null;
};

/** public.ad_account_diagnostics rows. */
export type DiagnosticsRow = {
  ad_account_id: string;
  provider: string;
  window_start: string;
  window_end: string;
  captured_at: string;
  payload: Record<string, unknown> | null;
};

/** PostgREST returns NUMERIC as strings and BIGINT as numbers; normalize both. */
export function num(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** True when a value is present but cannot be read as a finite number. */
export function isInvalidNumber(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return !Number.isFinite(parsed);
}

function provider(value: string): Provider {
  if (value === "meta" || value === "google") return value;
  throw new Error(`Unsupported provider: ${value}`);
}

const METRIC_FIELDS = ["impressions", "reach", "clicks", "spend", "conversions", "conversion_value"] as const;

function invalidFields(row: Record<string, unknown>, fields: readonly string[]): string[] {
  return fields.filter((field) => isInvalidNumber(row[field]) || (typeof row[field] !== "undefined" && num(row[field] as number) < 0));
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** campaigns.details (snake_case JSON written by the sync) -> CampaignContext. */
export function toCampaignContext(details: Record<string, unknown> | null | undefined): CampaignContext | undefined {
  if (!details || typeof details !== "object" || Object.keys(details).length === 0) return undefined;
  const reasons = Array.isArray(details.primary_status_reasons)
    ? details.primary_status_reasons.filter((reason): reason is string => typeof reason === "string")
    : [];
  const level = details.budget_level === "campaign" || details.budget_level === "ad_set" ? details.budget_level : null;
  return {
    channelSubType: stringOrNull(details.channel_sub_type),
    servingStatus: stringOrNull(details.serving_status),
    primaryStatus: stringOrNull(details.primary_status),
    primaryStatusReasons: reasons,
    start: stringOrNull(details.start),
    end: stringOrNull(details.end),
    budgetId: stringOrNull(details.budget_id),
    budgetShared: typeof details.budget_shared === "boolean" ? details.budget_shared : null,
    budgetPeriod: stringOrNull(details.budget_period),
    budgetReferenceCount: numberOrNull(details.budget_reference_count),
    lifetimeBudget: numberOrNull(details.lifetime_budget),
    budgetLevel: level,
    capturedAt: stringOrNull(details.captured_at),
  };
}

export function toAuditCampaign(row: CampaignPerformanceRow, details?: Record<string, unknown> | null): AuditCampaign {
  return {
    id: row.campaign_id,
    adAccountId: row.ad_account_id,
    provider: provider(row.provider),
    name: row.campaign_name?.trim() || `Campaign ${row.external_campaign_id}`,
    objective: row.objective,
    status: row.campaign_status,
    channelType: row.channel_type,
    bidStrategy: row.bid_strategy,
    dailyBudget: row.daily_budget === null ? null : num(row.daily_budget),
    impressions: num(row.impressions),
    reach: num(row.reach),
    clicks: num(row.clicks),
    spend: num(row.spend),
    conversions: num(row.conversions),
    conversionValue: num(row.conversion_value),
    activeDays: num(row.active_days),
    externalId: row.external_campaign_id,
    currency: row.currency,
    details: toCampaignContext(details),
  };
}

export function toAuditDaily(row: DailyPerformanceRow): AuditDailyRow {
  return {
    date: row.metric_date,
    adAccountId: row.ad_account_id,
    impressions: num(row.impressions),
    reach: num(row.reach),
    clicks: num(row.clicks),
    spend: num(row.spend),
    conversions: num(row.conversions),
    conversionValue: num(row.conversion_value),
    currency: row.currency,
  };
}

/**
 * sync_jobs -> per-account sync outcomes. Jobs written by sync 2.0 carry
 * stats.account_results; older jobs only know the connection, the window and
 * the number of failed accounts, so they count as a success for every
 * selected account of the connection only when no account failed.
 */
export function toSyncRuns(jobs: SyncJobRow[], accounts: AuditAccount[]): SyncRunRecord[] {
  const runs: SyncRunRecord[] = [];
  for (const job of jobs) {
    if (job.status !== "completed" && job.status !== "failed") continue;
    const stats = job.stats ?? {};
    const window = (stats.window ?? null) as { since?: unknown; until?: unknown } | null;
    const since = stringOrNull(window?.since);
    const until = stringOrNull(window?.until);
    const results = Array.isArray(stats.account_results) ? stats.account_results as Array<Record<string, unknown>> : null;
    if (results) {
      for (const result of results) {
        const adAccountId = stringOrNull(result.ad_account_id);
        if (!adAccountId) continue;
        runs.push({
          adAccountId,
          connectionId: job.connection_id,
          jobType: job.job_type,
          status: result.status === "succeeded" ? "succeeded" : "failed",
          completedAt: job.completed_at,
          since: stringOrNull(result.since) ?? since,
          until: stringOrNull(result.until) ?? until,
          invalidValues: num(result.invalid_values as number),
          unavailableFields: Array.isArray(result.unavailable_fields)
            ? (result.unavailable_fields as unknown[]).filter((field): field is string => typeof field === "string")
            : [],
          error: stringOrNull(result.error),
          legacy: false,
        });
      }
      continue;
    }
    const failedAccounts = num(stats.failed_accounts as number);
    const succeeded = job.status === "completed" && failedAccounts === 0;
    for (const account of accounts) {
      if (!account.connectionId || account.connectionId !== job.connection_id) continue;
      runs.push({
        adAccountId: account.id,
        connectionId: job.connection_id,
        jobType: job.job_type,
        status: succeeded ? "succeeded" : "failed",
        completedAt: job.completed_at,
        since,
        until,
        invalidValues: 0,
        unavailableFields: [],
        error: succeeded ? null : (job.error_message ?? (failedAccounts > 0 ? `${failedAccounts} account(s) failed; which ones was not recorded` : "Sync failed")),
        legacy: true,
      });
    }
  }
  return runs;
}

function toSection(value: unknown): DiagnosticSectionInput | null {
  if (!value || typeof value !== "object") return null;
  const section = value as Record<string, unknown>;
  if (section.status === "ok" && Array.isArray(section.rows)) {
    return { status: "ok", rows: section.rows as Array<Record<string, unknown>>, truncated: section.truncated === true };
  }
  if (section.status === "unavailable") return { status: "unavailable", reason: stringOrNull(section.reason) ?? "unavailable" };
  return null;
}

export function toDiagnostics(rows: DiagnosticsRow[]): AccountDiagnosticsInput[] {
  return rows.flatMap((row) => {
    const sections = (row.payload?.sections ?? null) as Record<string, unknown> | null;
    if (!sections || (row.provider !== "meta" && row.provider !== "google")) return [];
    const parsed: Record<string, DiagnosticSectionInput> = {};
    for (const [name, value] of Object.entries(sections)) {
      const section = toSection(value);
      if (section) parsed[name] = section;
    }
    return [{
      adAccountId: row.ad_account_id,
      provider: row.provider,
      windowStart: row.window_start,
      windowEnd: row.window_end,
      capturedAt: row.captured_at,
      sections: parsed,
    }];
  });
}

export function buildAuditInput(options: {
  tenantName: string;
  periodStart: string;
  periodEnd: string;
  accounts: AccountRow[];
  campaigns: CampaignPerformanceRow[];
  daily: DailyPerformanceRow[];
  campaignDetails?: CampaignDetailsRow[];
  syncJobs?: SyncJobRow[];
  diagnostics?: DiagnosticsRow[];
  targets?: BusinessTarget[];
  benchmarks?: Benchmark[];
  generatedAt?: string;
}): AuditInput {
  const accounts: AuditAccount[] = options.accounts.map((account) => ({
    id: account.id,
    provider: provider(account.provider),
    name: account.account_name?.trim() || account.external_account_id,
    currency: account.currency,
    externalId: account.external_account_id,
    connectionId: account.connection_id ?? null,
    status: account.status ?? null,
    timezone: account.timezone ?? null,
    syncEnabled: account.sync_enabled ?? null,
    lastSyncedAt: account.last_synced_at ?? null,
  }));
  const selected = new Set(accounts.map((account) => account.id));
  const details = new Map((options.campaignDetails ?? []).map((row) => [row.id, row.details]));
  const issues: DataIssue[] = [];

  const campaignRows = options.campaigns.filter((row) => selected.has(row.ad_account_id));
  for (const row of campaignRows) {
    const bad = invalidFields(row as unknown as Record<string, unknown>, METRIC_FIELDS);
    if (bad.length > 0) {
      issues.push({
        code: "invalid_numeric_value",
        level: "major",
        adAccountId: row.ad_account_id,
        campaignId: row.campaign_id,
        message: `Campaign totals contain values that are not valid non-negative numbers (${bad.join(", ")}); they were not counted.`,
        details: { fields: bad.join(", ") },
      });
    }
  }
  const dailyRows = options.daily.filter((row) => selected.has(row.ad_account_id));
  const invalidDaily = new Map<string, number>();
  for (const row of dailyRows) {
    if (invalidFields(row as unknown as Record<string, unknown>, METRIC_FIELDS).length > 0) {
      invalidDaily.set(row.ad_account_id, (invalidDaily.get(row.ad_account_id) ?? 0) + 1);
    }
  }
  for (const [adAccountId, count] of invalidDaily) {
    issues.push({
      code: "invalid_numeric_value",
      level: "major",
      adAccountId,
      campaignId: null,
      message: `${count} daily row(s) contain values that are not valid non-negative numbers; they were not counted.`,
      details: { rows: count },
    });
  }

  const clamp = <T extends Record<string, unknown>>(row: T): T => {
    const copy = { ...row } as Record<string, unknown>;
    for (const field of ["impressions", "reach", "clicks", "spend", "conversions", "conversionValue"]) {
      if (typeof copy[field] === "number" && (copy[field] as number) < 0) copy[field] = 0;
    }
    return copy as T;
  };

  return {
    tenantName: options.tenantName,
    periodStart: options.periodStart,
    periodEnd: options.periodEnd,
    accounts,
    campaigns: campaignRows.map((row) => clamp(toAuditCampaign(row, details.get(row.campaign_id)))),
    daily: dailyRows.map((row) => clamp(toAuditDaily(row))),
    syncRuns: options.syncJobs ? toSyncRuns(options.syncJobs, accounts) : undefined,
    diagnostics: options.diagnostics ? toDiagnostics(options.diagnostics).filter((item) => selected.has(item.adAccountId)) : undefined,
    targets: options.targets?.filter((target) => selected.has(target.adAccountId)),
    benchmarks: options.benchmarks,
    inputIssues: issues,
    generatedAt: options.generatedAt,
  };
}
