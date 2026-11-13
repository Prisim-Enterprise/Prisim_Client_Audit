import type { SupabaseClient } from "@supabase/supabase-js";
import { num } from "@functions/_shared/audit/input.ts";
import type { TenantRole } from "../auth-context";
import { ApiError, databaseError, functionError } from "./errors";
import type {
  ActivityEntry,
  AdAccount,
  AuditFinding,
  AuditRun,
  CampaignPerformance,
  Connection,
  DailyPerformance,
  IntegrationStatus,
  Invitation,
  Member,
  OAuthCompletion,
  PlatformOverview,
  PortalApi,
  Provider,
  Report,
  SyncJob,
  Tenant,
  TenantSyncStatus,
} from "./types";

// Column lists are explicit: several tables use column-level grants, so
// select("*") would be rejected (and must never expose hidden columns).
const TENANT_COLUMNS = "id, business_name, slug, email, status, industry, website, primary_contact_name, created_at, updated_at";
const CONNECTION_COLUMNS = "id, tenant_id, provider, provider_account_id, account_name, status, token_expires_at, scopes, created_at, updated_at";
const AD_ACCOUNT_COLUMNS = "id, tenant_id, connection_id, provider, external_account_id, account_name, currency, timezone, status, sync_enabled, last_synced_at";
const INVITATION_COLUMNS = "id, tenant_id, email, role, status, expires_at, created_at";
const SYNC_JOB_COLUMNS = "id, tenant_id, connection_id, provider, job_type, status, attempts, started_at, completed_at, error_message, created_at";
const AUDIT_RUN_COLUMNS = "id, tenant_id, title, period_start, period_end, status, engine_version, overall_score, platform_scores, category_scores, kpis, summary, ad_account_ids, reviewed_at, published_at, created_at, updated_at";
const FINDING_COLUMNS = "id, tenant_id, audit_run_id, ad_account_id, campaign_id, rule_id, category, platform, severity, title, description, recommendation, evidence, estimated_impact, impact_currency, status, reviewer_note, sort_order";
const REPORT_COLUMNS = "id, tenant_id, audit_run_id, report_name, report_type, storage_path, status, visibility, file_size_bytes, error_message, generated_at, published_at, created_at";

const PAGE_SIZE = 1000;

function unwrap<T>(result: { data: T | null; error: { code?: string; message?: string } | null }, fallback?: string): T {
  if (result.error) throw databaseError(result.error, fallback);
  return result.data as T;
}

function normalizeRun(row: AuditRun): AuditRun {
  return { ...row, overall_score: row.overall_score === null ? null : num(row.overall_score) };
}

function normalizeCampaign(row: CampaignPerformance): CampaignPerformance {
  return {
    ...row,
    daily_budget: row.daily_budget === null ? null : num(row.daily_budget),
    impressions: num(row.impressions),
    reach: num(row.reach),
    clicks: num(row.clicks),
    spend: num(row.spend),
    conversions: num(row.conversions),
    conversion_value: num(row.conversion_value),
    active_days: num(row.active_days),
  };
}

function normalizeDaily(row: DailyPerformance): DailyPerformance {
  return {
    ...row,
    impressions: num(row.impressions),
    reach: num(row.reach),
    clicks: num(row.clicks),
    spend: num(row.spend),
    conversions: num(row.conversions),
    conversion_value: num(row.conversion_value),
  };
}

export function createSupabaseApi(typedClient: SupabaseClient<never> | SupabaseClient): PortalApi {
  // Generated types cover only the auth RPCs; data queries use explicit row types.
  const supabase = typedClient as unknown as SupabaseClient;

  async function invoke<T>(name: string, body: Record<string, unknown>): Promise<T> {
    const { data, error } = await supabase.functions.invoke(name, { body });
    if (error) throw await functionError(error, name);
    return data as T;
  }

  async function allRows<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { code?: string; message?: string } | null }>): Promise<T[]> {
    const rows: T[] = [];
    for (let from = 0; from < 50000; from += PAGE_SIZE) {
      const data = unwrap(await build(from, from + PAGE_SIZE - 1));
      rows.push(...(data ?? []));
      if (!data || data.length < PAGE_SIZE) break;
    }
    return rows;
  }

  return {
    mode: "live",

    async getPlatformOverview() {
      return unwrap(await supabase.rpc("get_platform_overview")) as PlatformOverview;
    },

    async listTenants() {
      return unwrap(await supabase.from("tenants").select(TENANT_COLUMNS).order("business_name")) as Tenant[];
    },

    async getTenant(tenantId) {
      return unwrap(await supabase.from("tenants").select(TENANT_COLUMNS).eq("id", tenantId).maybeSingle()) as Tenant | null;
    },

    async createTenant(input) {
      return unwrap(
        await supabase.from("tenants").insert({ ...input, status: "active" }).select(TENANT_COLUMNS).single(),
        "The client could not be created. Check that the slug is unique.",
      ) as Tenant;
    },

    async updateTenant(tenantId, patch) {
      unwrap(await supabase.from("tenants").update(patch).eq("id", tenantId));
    },

    async listMembers(tenantId) {
      return unwrap(await supabase.rpc("get_tenant_members", { p_tenant_id: tenantId })) as Member[];
    },

    async listInvitations(tenantId) {
      return unwrap(
        await supabase.from("tenant_invitations").select(INVITATION_COLUMNS).eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(50),
      ) as Invitation[];
    },

    async inviteMember(tenantId, email, role) {
      await invoke("invite-tenant-member", { tenantId, email, role });
    },

    async revokeInvitation(invitationId) {
      unwrap(await supabase.rpc("revoke_invitation", { p_invitation_id: invitationId }));
    },

    async changeMemberRole(tenantId, userId, role: TenantRole) {
      unwrap(await supabase.rpc("change_member_role", { p_tenant_id: tenantId, p_user_id: userId, p_role: role }));
    },

    async deactivateMember(tenantId, userId) {
      unwrap(await supabase.rpc("deactivate_member", { p_tenant_id: tenantId, p_user_id: userId }));
    },

    async getIntegrationStatus(): Promise<IntegrationStatus> {
      try {
        const data = await invoke<{ providers: Record<Provider, { configured: boolean; missing: string[]; apiVersion: string }> }>(
          "ad-connections",
          { action: "providers" },
        );
        return { state: "available", providers: data.providers };
      } catch (error) {
        return {
          state: "service_unavailable",
          message: error instanceof ApiError ? error.message : "The connection service could not be reached.",
        };
      }
    },

    async listConnections(tenantId) {
      let query = supabase.from("oauth_connections").select(CONNECTION_COLUMNS).neq("status", "pending").order("created_at", { ascending: false });
      if (tenantId) query = query.eq("tenant_id", tenantId);
      return unwrap(await query) as Connection[];
    },

    async listAdAccounts(tenantId) {
      let query = supabase.from("ad_accounts").select(AD_ACCOUNT_COLUMNS).order("provider").order("account_name");
      if (tenantId) query = query.eq("tenant_id", tenantId);
      return unwrap(await query) as AdAccount[];
    },

    async startOAuth(tenantId, provider) {
      return invoke<{ authorizeUrl: string }>("ad-connections", { action: "start", tenantId, provider });
    },

    async completeOAuth(code, state) {
      return invoke<OAuthCompletion>("ad-connections", { action: "complete", code, state });
    },

    async disconnect(connectionId) {
      await invoke("ad-connections", { action: "disconnect", connectionId });
    },

    async setAdAccountSync(connectionId, adAccountIds) {
      return unwrap(await supabase.rpc("set_ad_account_sync", { p_connection_id: connectionId, p_ad_account_ids: adAccountIds })) as number;
    },

    async startSync(connectionId, jobType = "manual_sync") {
      return invoke<{ jobId: string }>("sync-ad-data", { action: "start", connectionId, jobType });
    },

    async listSyncJobs(tenantId) {
      let query = supabase.from("sync_jobs").select(SYNC_JOB_COLUMNS).order("created_at", { ascending: false }).limit(100);
      if (tenantId) query = query.eq("tenant_id", tenantId);
      return unwrap(await query) as SyncJob[];
    },

    async getTenantSyncStatus(tenantId) {
      return unwrap(await supabase.rpc("get_tenant_sync_status", { p_tenant_id: tenantId })) as TenantSyncStatus[];
    },

    async getCampaignPerformance(tenantId, range, adAccountId) {
      const rows = await allRows<CampaignPerformance>((from, to) =>
        supabase
          .rpc("get_campaign_performance", { p_tenant_id: tenantId, p_from: range.from, p_to: range.to, p_ad_account_id: adAccountId ?? null })
          .range(from, to)
      );
      return rows.map(normalizeCampaign);
    },

    async getDailyPerformance(tenantId, range, adAccountId) {
      const rows = await allRows<DailyPerformance>((from, to) =>
        supabase
          .rpc("get_daily_performance", { p_tenant_id: tenantId, p_from: range.from, p_to: range.to, p_ad_account_id: adAccountId ?? null })
          .range(from, to)
      );
      return rows.map(normalizeDaily);
    },

    async listAuditRuns(tenantId) {
      let query = supabase.from("audit_runs").select(AUDIT_RUN_COLUMNS).order("created_at", { ascending: false }).limit(200);
      if (tenantId) query = query.eq("tenant_id", tenantId);
      return (unwrap(await query) as AuditRun[]).map(normalizeRun);
    },

    async getAuditRun(auditRunId) {
      const row = unwrap(await supabase.from("audit_runs").select(AUDIT_RUN_COLUMNS).eq("id", auditRunId).maybeSingle()) as AuditRun | null;
      return row ? normalizeRun(row) : null;
    },

    async listFindings(auditRunId) {
      const rows = unwrap(await supabase.from("audit_findings").select(FINDING_COLUMNS).eq("audit_run_id", auditRunId).order("sort_order")) as AuditFinding[];
      return rows.map((row) => ({ ...row, estimated_impact: row.estimated_impact === null ? null : num(row.estimated_impact) }));
    },

    async runAudit(input) {
      return invoke<{ auditRunId: string }>("run-audit", input);
    },

    async updateFinding(findingId, patch) {
      unwrap(await supabase.from("audit_findings").update(patch).eq("id", findingId));
    },

    async setAuditStatus(auditRunId, status, summary) {
      unwrap(await supabase.rpc("set_audit_run_status", { p_run_id: auditRunId, p_status: status, p_summary: summary ?? null }));
    },

    async updateAuditSummary(auditRunId, summary) {
      unwrap(await supabase.from("audit_runs").update({ summary: summary.trim() || null }).eq("id", auditRunId));
    },

    async deleteAuditRun(auditRunId) {
      unwrap(await supabase.from("audit_runs").delete().eq("id", auditRunId));
    },

    async listReports(tenantId) {
      let query = supabase.from("reports").select(REPORT_COLUMNS).order("created_at", { ascending: false }).limit(200);
      if (tenantId) query = query.eq("tenant_id", tenantId);
      return unwrap(await query) as Report[];
    },

    async generateReport(auditRunId, shareWithClient) {
      return invoke<{ reportId: string }>("generate-report", { auditRunId, shareWithClient });
    },

    async setReportVisibility(reportId, visibility) {
      unwrap(await supabase.from("reports").update({ visibility }).eq("id", reportId));
    },

    async deleteReport(report) {
      if (report.storage_path) {
        const { error } = await supabase.storage.from("reports").remove([report.storage_path]);
        if (error) throw new ApiError("The report file could not be deleted.", "storage_error");
      }
      unwrap(await supabase.from("reports").delete().eq("id", report.id));
    },

    async downloadReport(report) {
      if (!report.storage_path || report.status !== "ready") throw new ApiError("This report is not ready yet.", "not_ready");
      const filename = `${report.report_name.replace(/[^\w.-]+/g, "_").slice(0, 120)}.pdf`;
      const { data, error } = await supabase.storage.from("reports").createSignedUrl(report.storage_path, 60, { download: filename });
      if (error || !data?.signedUrl) throw new ApiError("The report could not be downloaded. You may not have access to it.", "storage_error");
      const link = document.createElement("a");
      link.href = data.signedUrl;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
    },

    async listActivity(tenantId) {
      let query = supabase
        .from("audit_logs")
        .select("id, tenant_id, user_id, actor_role, action, entity_type, entity_id, created_at")
        .order("created_at", { ascending: false })
        .limit(150);
      if (tenantId) query = query.eq("tenant_id", tenantId);
      const rows = unwrap(await query) as Omit<ActivityEntry, "actor_email">[];
      const ids = [...new Set(rows.map((row) => row.user_id).filter((id): id is string => Boolean(id)))];
      const emails = new Map<string, string | null>();
      if (ids.length > 0) {
        const { data } = await supabase.from("profiles").select("id, email").in("id", ids);
        for (const profile of (data ?? []) as Array<{ id: string; email: string | null }>) emails.set(profile.id, profile.email);
      }
      return rows.map((row) => ({ ...row, actor_email: row.user_id ? emails.get(row.user_id) ?? null : null }));
    },

    subscribe(tables, onChange) {
      const channel = supabase.channel(`prisim-${tables.join("-")}-${Math.random().toString(36).slice(2, 8)}`);
      for (const table of tables) {
        channel.on("postgres_changes", { event: "*", schema: "public", table }, () => onChange());
      }
      channel.subscribe();
      return () => {
        void supabase.removeChannel(channel);
      };
    },
  };
}
