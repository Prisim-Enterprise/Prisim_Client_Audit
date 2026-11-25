// generate-report: renders an audit as a PDF and stores it in the private
// `reports` bucket at <tenant_id>/<report_id>.pdf. Runs with the caller's JWT
// (aal2 platform admin): the reports row, the storage upload and the status
// update are all authorized by RLS / storage policies and audited.

import type { CampaignPerformanceRow } from "../_shared/audit/input.ts";
import { bearerToken, HttpError, isUuid, json, readBody, withHttp } from "../_shared/http.ts";
import { fetchAllRows } from "../_shared/paging.ts";
import { type AuditFindingRow, type AuditRunRow, toReportData } from "../_shared/report/data.ts";
import { buildAuditReportPdf } from "../_shared/report/pdf.ts";
import { readServerConfig, requirePlatformAdmin, requireUser, userClient } from "../_shared/supabase.ts";

async function handle(request: Request, origin: string): Promise<Response> {
  const config = readServerConfig(false);
  const jwt = bearerToken(request);
  const userId = await requireUser(config, jwt);
  const client = userClient(config, jwt!);
  await requirePlatformAdmin(client);

  const body = await readBody(request);
  if (!isUuid(body.auditRunId)) throw new HttpError(400, "invalid_request");
  const share = body.shareWithClient === true;

  const { data: run, error: runError } = await client
    .from("audit_runs")
    .select("id, tenant_id, title, period_start, period_end, status, engine_version, overall_score, platform_scores, category_scores, kpis, summary, ad_account_ids")
    .eq("id", body.auditRunId)
    .maybeSingle();
  if (runError || !run) throw new HttpError(404, "audit_not_found");
  if (share && run.status !== "published") throw new HttpError(409, "audit_not_published");

  const { data: tenant } = await client.from("tenants").select("business_name").eq("id", run.tenant_id).maybeSingle();
  const { data: findings, error: findingsError } = await client
    .from("audit_findings")
    .select("severity, category, platform, title, description, recommendation, reviewer_note, status, estimated_impact, impact_currency, sort_order")
    .eq("audit_run_id", run.id)
    .order("sort_order");
  if (findingsError) throw new HttpError(500, "data_unavailable");
  const accountIds = new Set<string>(run.ad_account_ids ?? []);
  const campaigns = (await fetchAllRows<CampaignPerformanceRow>(() =>
    client.rpc("get_campaign_performance", { p_tenant_id: run.tenant_id, p_from: run.period_start, p_to: run.period_end })
  )).filter((row) => accountIds.size === 0 || accountIds.has(row.ad_account_id));

  const tenantName = tenant?.business_name ?? "Client";
  const { data: report, error: insertError } = await client
    .from("reports")
    .insert({
      tenant_id: run.tenant_id,
      audit_run_id: run.id,
      report_name: `${tenantName} - ${run.title}`.slice(0, 200),
      report_type: "audit_pdf",
      status: "generating",
      created_by: userId,
    })
    .select("id")
    .single();
  if (insertError || !report) throw new HttpError(500, "report_not_created");

  try {
    const pdf = await buildAuditReportPdf(toReportData({
      tenantName,
      run: run as AuditRunRow,
      findings: (findings ?? []) as AuditFindingRow[],
      campaigns,
    }));
    const path = `${run.tenant_id}/${report.id}.pdf`;
    const { error: uploadError } = await client.storage.from("reports").upload(path, pdf, {
      contentType: "application/pdf",
      upsert: true,
    });
    if (uploadError) throw new Error("upload_failed");

    const { error: updateError } = await client
      .from("reports")
      .update({
        status: "ready",
        storage_path: path,
        generated_at: new Date().toISOString(),
        file_size_bytes: pdf.byteLength,
        error_message: null,
        visibility: share ? "client" : "internal",
      })
      .eq("id", report.id);
    if (updateError) throw new Error("update_failed");
    return json(200, { reportId: report.id, status: "ready", sizeBytes: pdf.byteLength }, origin);
  } catch (error) {
    await client
      .from("reports")
      .update({ status: "failed", error_message: error instanceof Error ? error.message.slice(0, 200) : "generation_failed" })
      .eq("id", report.id);
    throw new HttpError(500, "report_generation_failed", { reportId: report.id });
  }
}

if (import.meta.main) {
  Deno.serve(withHttp(Deno.env.get("APP_URL"), handle, console.warn));
}
