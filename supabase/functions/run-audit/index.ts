// run-audit: runs the PRISIM audit engine for a tenant and stores the result
// as a draft audit (public.save_audit_run). Runs entirely with the caller's
// JWT: only aal2 platform admins can read the data and save the run, and the
// audit trail names the reviewer. No service_role key is used.

import { runAudit } from "../_shared/audit/engine.ts";
import { type AccountRow, buildAuditInput, type CampaignPerformanceRow, type DailyPerformanceRow } from "../_shared/audit/input.ts";
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
    .select("id, provider, account_name, external_account_id, currency, sync_enabled")
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

  const input = buildAuditInput({
    tenantName: tenant.business_name,
    periodStart,
    periodEnd,
    accounts,
    campaigns,
    daily,
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
    findings: result.findings.length,
  }, origin);
}

if (import.meta.main) {
  Deno.serve(withHttp(Deno.env.get("APP_URL"), handle, console.warn));
}
