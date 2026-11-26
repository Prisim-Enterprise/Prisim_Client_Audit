// run-audit: runs the PRISIM audit engine for a tenant and stores the result
// as a draft audit (public.save_audit_run). Runs entirely with the caller's
// JWT: only aal2 platform admins can read the data and save the run, and the
// audit trail names the reviewer. No service_role key is used.

import { runAudit } from "../_shared/audit/engine.ts";
import {
  type AccountRow,
  buildAuditInput,
  type CampaignDetailsRow,
  type CampaignPerformanceRow,
  type DailyPerformanceRow,
  type DiagnosticsRow,
  type SyncJobRow,
} from "../_shared/audit/input.ts";
import type { BusinessTarget } from "../_shared/audit/types.ts";
import { toSaveAuditPayload } from "../_shared/audit/payload.ts";
import { daysBetweenInclusive } from "../_shared/format.ts";
import { bearerToken, HttpError, isIsoDate, isUuid, json, readBody, withHttp } from "../_shared/http.ts";
import { fetchAllRows } from "../_shared/paging.ts";
import { readServerConfig, requirePlatformAdmin, requireUser, userClient } from "../_shared/supabase.ts";

async function handle(request: Request, origin: string): Promise<Response> {
  const config = readServerConfig(false);
  const jwt = bearerToken(request);
  await requireUser(config, jwt);
  const client = userClient(config, jwt!);
  await requirePlatformAdmin(client);

  const body = await readBody(request);
  const { tenantId, periodStart, periodEnd } = body;
  if (!isUuid(tenantId) || !isIsoDate(periodStart) || !isIsoDate(periodEnd)) throw new HttpError(400, "invalid_request");
  const days = daysBetweenInclusive(periodStart, periodEnd);
  if (days < 7 || days > 366) throw new HttpError(400, "invalid_period");
  const requested = Array.isArray(body.adAccountIds) ? body.adAccountIds.filter(isUuid) : [];

  const { data: tenant, error: tenantError } = await client.from("tenants").select("id, business_name").eq("id", tenantId).maybeSingle();
  if (tenantError || !tenant) throw new HttpError(404, "tenant_not_found");

  const { data: accountRows, error: accountError } = await client
    .from("ad_accounts")
    .select("id, provider, account_name, external_account_id, currency, sync_enabled, connection_id, status, timezone, last_synced_at")
    .eq("tenant_id", tenantId);
  if (accountError) throw new HttpError(500, "data_unavailable");
  const all = (accountRows ?? []) as Array<AccountRow & { sync_enabled: boolean }>;
  const accounts = requested.length > 0
    ? all.filter((account) => requested.includes(account.id))
    : all.filter((account) => account.sync_enabled).length > 0
    ? all.filter((account) => account.sync_enabled)
    : all;
  if (accounts.length === 0) throw new HttpError(422, "no_ad_accounts");

  const campaigns = await fetchAllRows<CampaignPerformanceRow>(() =>
    client.rpc("get_campaign_performance", { p_tenant_id: tenantId, p_from: periodStart, p_to: periodEnd })
  );
  const daily = await fetchAllRows<DailyPerformanceRow>(() =>
    client.rpc("get_daily_performance", { p_tenant_id: tenantId, p_from: periodStart, p_to: periodEnd })
  );

  const accountIds = accounts.map((account) => account.id);
  // Sync records decide which days were actually retrieved. A job can cover
  // period days only if it completed on or after the period start.
  const { data: jobs, error: jobsError } = await client
    .from("sync_jobs")
    .select("id, connection_id, job_type, status, completed_at, error_message, stats")
    .eq("tenant_id", tenantId)
    .in("status", ["completed", "failed"])
    .gte("completed_at", `${periodStart}T00:00:00Z`)
    .order("completed_at", { ascending: false })
    .limit(500);
  if (jobsError) throw new HttpError(500, "data_unavailable");

  // campaigns.details and ad_account_diagnostics come from 20261126100000.
  // Until that migration is applied both are read as "not available" and the
  // audit reports the gap instead of failing.
  const { data: details, error: detailsError } = await client
    .from("campaigns")
    .select("id, details")
    .in("ad_account_id", accountIds)
    .limit(5000);
  const { data: diagnostics, error: diagnosticsError } = await client
    .from("ad_account_diagnostics")
    .select("ad_account_id, provider, window_start, window_end, captured_at, payload")
    .in("ad_account_id", accountIds);

  const input = buildAuditInput({
    tenantName: tenant.business_name,
    periodStart,
    periodEnd,
    accounts,
    campaigns,
    daily,
    campaignDetails: detailsError ? undefined : (details ?? []) as CampaignDetailsRow[],
    syncJobs: (jobs ?? []) as SyncJobRow[],
    diagnostics: diagnosticsError ? undefined : (diagnostics ?? []) as DiagnosticsRow[],
    targets: parseTargets(body.targets, accountIds),
    generatedAt: new Date().toISOString(),
  });
  if (input.campaigns.length === 0) throw new HttpError(422, "no_campaign_data");

  const result = runAudit(input);
  const title = typeof body.title === "string" && body.title.trim()
    ? body.title.trim()
    : `Advertising audit ${periodStart} to ${periodEnd}`;
  const payload = toSaveAuditPayload(result, {
    title,
    periodStart,
    periodEnd,
    adAccountIds: accounts.map((account) => account.id),
  });
  const { data: auditRunId, error: saveError } = await client.rpc("save_audit_run", {
    p_tenant_id: tenantId,
    p_run: payload.run,
    p_findings: payload.findings,
  });
  if (saveError || typeof auditRunId !== "string") throw new HttpError(500, "audit_not_saved");

  return json(200, {
    auditRunId,
    overallScore: result.overallScore,
    scoreStatus: result.scoreStatus,
    findings: result.findings.length,
  }, origin);
}

const GOALS = new Set(["sales", "leads", "app", "conversions", "traffic", "awareness"]);

/** Optional business targets per selected ad account: { [adAccountId]: { targetCpa?, targetRoas?, goal? } }. */
export function parseTargets(value: unknown, accountIds: string[]): BusinessTarget[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const targets: BusinessTarget[] = [];
  for (const [adAccountId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!accountIds.includes(adAccountId) || !raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const positive = (input: unknown) => (typeof input === "number" && Number.isFinite(input) && input > 0 && input < 1e9 ? input : null);
    const target: BusinessTarget = {
      adAccountId,
      targetCpa: positive(item.targetCpa),
      targetRoas: positive(item.targetRoas),
      goal: typeof item.goal === "string" && GOALS.has(item.goal) ? item.goal as BusinessTarget["goal"] : null,
    };
    if (target.targetCpa || target.targetRoas || target.goal) targets.push(target);
  }
  return targets;
}

if (import.meta.main) {
  Deno.serve(withHttp(Deno.env.get("APP_URL"), handle, console.warn));
}
