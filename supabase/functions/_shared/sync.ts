// Sync orchestration, independent of Supabase and HTTP so it can be tested
// with fakes. The Edge Function supplies the database and provider calls.

import { addDays, isoDate } from "./format.ts";
import { type AccountDiagnostics, type AdProvider, type MetricRecord, ProviderError, type SyncAccount } from "./providers/types.ts";

/**
 * Per-account outcome recorded in sync_jobs.stats.account_results. The audit
 * engine uses it to decide which days of which account were actually
 * retrieved: a job that completed is not proof that every account in it did.
 */
export type AccountSyncResult = {
  ad_account_id: string;
  external_account_id: string;
  status: "succeeded" | "failed";
  since: string;
  until: string;
  campaigns: number;
  metrics: number;
  /** Platform values that were present but not numeric (stored as 0). */
  invalid_values: number;
  /** Metric fields the platform could not return for this window (e.g. Meta reach). */
  unavailable_fields: string[];
  diagnostics: "stored" | "failed" | "skipped";
  error: string | null;
};

/** Diagnostics cover the last 30 complete days of the sync window. */
export function diagnosticsWindow(window: { since: string; until: string }): { since: string; until: string } {
  const since = addDays(window.until, -29);
  return { since: since > window.since ? since : window.since, until: window.until };
}

function metricQuality(metrics: MetricRecord[]) {
  let invalid = 0;
  const unavailable = new Set<string>();
  for (const metric of metrics) {
    for (const field of metric.invalid_fields ?? []) {
      if (field.endsWith("_unavailable")) unavailable.add(field.replace(/_unavailable$/, ""));
      else invalid += 1;
    }
  }
  return { invalid, unavailable: [...unavailable].sort() };
}

export type ClaimedJob = {
  job_id: string;
  tenant_id: string;
  connection_id: string;
  provider: "meta" | "google";
  job_type: "daily_sync" | "backfill" | "manual_sync";
  last_success_at: string | null;
  accounts: SyncAccount[];
};

export type StoredTokens = {
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
};

export type SyncDependencies = {
  provider(name: "meta" | "google"): AdProvider;
  getTokens(connectionId: string): Promise<StoredTokens | null>;
  storeRefreshedTokens(connectionId: string, accessToken: string, refreshToken: string | null, expiresAt: string | null): Promise<void>;
  ingest(jobId: string, adAccountId: string, campaigns: unknown[], metrics: unknown[]): Promise<{ campaigns: number; metrics: number }>;
  /** Latest diagnostics snapshot per ad account. Optional: older deployments skip it. */
  storeDiagnostics?(jobId: string, adAccountId: string, diagnostics: AccountDiagnostics): Promise<void>;
  complete(jobId: string, success: boolean, error: string | null, stats: Record<string, unknown>): Promise<void>;
  setConnectionStatus(connectionId: string, status: "expired" | "error"): Promise<void>;
  now(): Date;
};

/** Days of data to (re)load. Recent days are re-read because platforms restate them. */
export function syncWindow(job: Pick<ClaimedJob, "job_type" | "last_success_at">, today: Date): { since: string; until: string } {
  const until = isoDate(new Date(today.getTime() - 86_400_000)); // through yesterday (complete days)
  if (job.job_type === "backfill" || !job.last_success_at) {
    return { since: addDays(until, -89), until };
  }
  if (job.job_type === "manual_sync") {
    return { since: addDays(until, -29), until };
  }
  const last = isoDate(new Date(job.last_success_at));
  const lookback = addDays(until, -6);
  const since = last < lookback ? addDays(last, -3) : lookback;
  return { since: since < addDays(until, -89) ? addDays(until, -89) : since, until };
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

/** Runs one claimed job to completion. Never throws; the job is always completed or failed. */
export async function processSyncJob(job: ClaimedJob, deps: SyncDependencies): Promise<{ success: boolean; error: string | null }> {
  const stats: Record<string, unknown> = { accounts: 0, campaigns: 0, metrics: 0, failed_accounts: 0 };
  try {
    if (job.accounts.length === 0) {
      await deps.complete(job.job_id, true, null, { ...stats, note: "No ad accounts selected for sync" });
      return { success: true, error: null };
    }
    const provider = deps.provider(job.provider);
    const stored = await deps.getTokens(job.connection_id);
    if (!stored?.access_token) throw new ProviderError("auth_expired", "No stored credentials. Reconnect the account.");

    let accessToken = stored.access_token;
    const expiresAt = stored.expires_at ? Date.parse(stored.expires_at) : null;
    if (expiresAt !== null && expiresAt - deps.now().getTime() < 5 * 60_000) {
      if (!stored.refresh_token) throw new ProviderError("auth_expired", "The connection has expired. Reconnect the account.");
      const refreshed = await provider.refresh(stored.refresh_token);
      accessToken = refreshed.accessToken;
      await deps.storeRefreshedTokens(job.connection_id, refreshed.accessToken, refreshed.refreshToken, refreshed.expiresAt);
    }

    const window = syncWindow(job, deps.now());
    stats.window = window;
    const errors: string[] = [];
    const results: AccountSyncResult[] = [];
    stats.account_results = results;
    for (const account of job.accounts) {
      const result: AccountSyncResult = {
        ad_account_id: account.id,
        external_account_id: account.external_account_id,
        status: "failed",
        since: window.since,
        until: window.until,
        campaigns: 0,
        metrics: 0,
        invalid_values: 0,
        unavailable_fields: [],
        diagnostics: "skipped",
        error: null,
      };
      results.push(result);
      try {
        const campaigns = await provider.fetchCampaigns(accessToken, account);
        const metrics = await provider.fetchMetrics(accessToken, account, window.since, window.until);
        const quality = metricQuality(metrics);
        // invalid_fields is diagnostic only; the ingest RPC ignores unknown keys.
        const clean = metrics.map(({ invalid_fields: _ignored, ...metric }) => metric);
        // The first batch carries all campaigns so metrics can resolve their ids.
        const batches = chunks(clean, 5000);
        const first = await deps.ingest(job.job_id, account.id, campaigns, batches[0] ?? []);
        let metricCount = first.metrics;
        for (const batch of batches.slice(1)) {
          metricCount += (await deps.ingest(job.job_id, account.id, [], batch)).metrics;
        }
        stats.accounts = (stats.accounts as number) + 1;
        stats.campaigns = (stats.campaigns as number) + first.campaigns;
        stats.metrics = (stats.metrics as number) + metricCount;
        Object.assign(result, {
          status: "succeeded",
          campaigns: first.campaigns,
          metrics: metricCount,
          invalid_values: quality.invalid,
          unavailable_fields: quality.unavailable,
        });
      } catch (error) {
        if (error instanceof ProviderError && error.code === "auth_expired") throw error;
        stats.failed_accounts = (stats.failed_accounts as number) + 1;
        result.error = error instanceof ProviderError ? error.message.slice(0, 200) : "unexpected error";
        errors.push(`${account.external_account_id}: ${result.error}`);
        continue;
      }
      // Diagnostics are best effort and never change the account's metric outcome.
      if (provider.fetchDiagnostics && deps.storeDiagnostics) {
        try {
          const range = diagnosticsWindow(window);
          const diagnostics = await provider.fetchDiagnostics(accessToken, account, range.since, range.until);
          await deps.storeDiagnostics(job.job_id, account.id, diagnostics);
          result.diagnostics = "stored";
        } catch (error) {
          if (error instanceof ProviderError && error.code === "auth_expired") throw error;
          result.diagnostics = "failed";
        }
      }
    }

    const success = errors.length < job.accounts.length;
    const message = errors.length > 0 ? errors.join("; ").slice(0, 480) : null;
    await deps.complete(job.job_id, success, success ? null : message, { ...stats, errors: message });
    return { success, error: message };
  } catch (error) {
    const message = error instanceof ProviderError ? error.message : "Unexpected sync error";
    if (error instanceof ProviderError && error.code === "auth_expired") {
      await deps.setConnectionStatus(job.connection_id, "expired").catch(() => undefined);
    }
    await deps.complete(job.job_id, false, message, stats).catch(() => undefined);
    return { success: false, error: message };
  }
}
