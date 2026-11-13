// In-memory PortalApi over synthetic fixtures (demo mode only). Uses the real
// audit engine and PDF builder so demo output matches production behaviour.
// Nothing here talks to Supabase.

import { runAudit } from "@functions/_shared/audit/engine.ts";
import { buildAuditInput } from "@functions/_shared/audit/input.ts";
import { toSaveAuditPayload } from "@functions/_shared/audit/payload.ts";
import { addDays, isoDate } from "@functions/_shared/format.ts";
import { toReportData } from "@functions/_shared/report/data.ts";
import { buildAuditReportPdf } from "@functions/_shared/report/pdf.ts";
import { ApiError } from "../lib/api/errors";
import type {
  ActivityEntry,
  AdAccount,
  AuditFinding,
  AuditRun,
  AuditStatus,
  CampaignPerformance,
  Connection,
  DailyPerformance,
  DateRange,
  Invitation,
  Member,
  PortalApi,
  Provider,
  RealtimeTable,
  Report,
  SyncJob,
  Tenant,
} from "../lib/api/types";
import {
  DEMO_TENANT_IDS,
  DEMO_USERS,
  type DemoCampaign,
  type DemoMetric,
  demoConnections,
  demoInvitations,
  demoMembers,
  demoSyncJobs,
  demoTenants,
  generateDemoData,
} from "./fixtures";

const wait = (ms = 220) => new Promise((resolve) => setTimeout(resolve, ms));
let counter = 0;
const newId = () => {
  counter++;
  const random = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return `de${random}-0000-4000-8000-${String(counter).padStart(12, "0")}`;
};

type DemoState = {
  tenants: Tenant[];
  members: Record<string, Member[]>;
  invitations: Invitation[];
  connections: Connection[];
  accounts: AdAccount[];
  campaigns: DemoCampaign[];
  metrics: DemoMetric[];
  jobs: SyncJob[];
  runs: AuditRun[];
  findings: AuditFinding[];
  reports: Report[];
  activity: ActivityEntry[];
};

export function createDemoApi(options: { actorId: () => string; actorEmail: () => string }): PortalApi {
  const data = generateDemoData();
  const state: DemoState = {
    tenants: demoTenants(),
    members: demoMembers(),
    invitations: demoInvitations(),
    connections: demoConnections(),
    accounts: data.accounts,
    campaigns: data.campaigns,
    metrics: data.metrics,
    jobs: demoSyncJobs(),
    runs: [],
    findings: [],
    reports: [],
    activity: [],
  };
  const listeners = new Map<number, { tables: RealtimeTable[]; onChange: () => void }>();
  let listenerId = 0;

  function emit(table: RealtimeTable) {
    for (const listener of listeners.values()) if (listener.tables.includes(table)) listener.onChange();
  }

  function log(action: string, tenantId: string | null, entityType: string, entityId: string | null) {
    state.activity.unshift({
      id: newId(),
      tenant_id: tenantId,
      user_id: options.actorId(),
      actor_role: "authenticated",
      action,
      entity_type: entityType,
      entity_id: entityId,
      created_at: new Date().toISOString(),
      actor_email: options.actorEmail(),
    });
  }

  function tenantOrThrow(tenantId: string) {
    const tenant = state.tenants.find((item) => item.id === tenantId);
    if (!tenant) throw new ApiError("Unknown client.", "22023");
    return tenant;
  }

  function campaignPerformance(tenantId: string, range: DateRange, adAccountId?: string): CampaignPerformance[] {
    return state.campaigns
      .filter((campaign) => campaign.tenant_id === tenantId && (!adAccountId || campaign.ad_account_id === adAccountId))
      .filter((campaign) => state.accounts.some((account) => account.id === campaign.ad_account_id))
      .map((campaign) => {
        const rows = state.metrics.filter((row) => row.campaign_id === campaign.campaign_id && row.metric_date >= range.from && row.metric_date <= range.to);
        const sum = (key: keyof DemoMetric) => rows.reduce((total, row) => total + (row[key] as number), 0);
        return {
          ...campaign,
          impressions: sum("impressions"),
          reach: sum("reach"),
          clicks: sum("clicks"),
          spend: Math.round(sum("spend") * 100) / 100,
          conversions: Math.round(sum("conversions") * 10) / 10,
          conversion_value: Math.round(sum("conversion_value") * 100) / 100,
          active_days: rows.filter((row) => row.impressions > 0 || row.spend > 0).length,
        };
      })
      .sort((a, b) => b.spend - a.spend);
  }

  function dailyPerformance(tenantId: string, range: DateRange, adAccountId?: string): DailyPerformance[] {
    const map = new Map<string, DailyPerformance>();
    for (const row of state.metrics) {
      if (row.tenant_id !== tenantId || row.metric_date < range.from || row.metric_date > range.to) continue;
      if (adAccountId && row.ad_account_id !== adAccountId) continue;
      const account = state.accounts.find((item) => item.id === row.ad_account_id);
      if (!account) continue;
      const key = `${row.metric_date}|${row.ad_account_id}`;
      const current = map.get(key) ?? {
        metric_date: row.metric_date,
        ad_account_id: row.ad_account_id,
        provider: account.provider,
        currency: account.currency,
        impressions: 0,
        reach: 0,
        clicks: 0,
        spend: 0,
        conversions: 0,
        conversion_value: 0,
      };
      current.impressions += row.impressions;
      current.reach += row.reach;
      current.clicks += row.clicks;
      current.spend += row.spend;
      current.conversions += row.conversions;
      current.conversion_value += row.conversion_value;
      map.set(key, current);
    }
    return [...map.values()].sort((a, b) => a.metric_date.localeCompare(b.metric_date));
  }

  function createRun(tenantId: string, periodStart: string, periodEnd: string, adAccountIds?: string[], title?: string): AuditRun {
    const tenant = tenantOrThrow(tenantId);
    const accounts = state.accounts.filter((account) =>
      account.tenant_id === tenantId && (adAccountIds?.length ? adAccountIds.includes(account.id) : account.sync_enabled)
    );
    if (accounts.length === 0) throw new ApiError("This client has no ad accounts to audit yet.", "no_ad_accounts");
    const range = { from: periodStart, to: periodEnd };
    const input = buildAuditInput({
      tenantName: tenant.business_name,
      periodStart,
      periodEnd,
      accounts: accounts.map((account) => ({ ...account })),
      campaigns: campaignPerformance(tenantId, range),
      daily: dailyPerformance(tenantId, range),
    });
    if (input.campaigns.length === 0) throw new ApiError("No campaign data exists for the selected accounts and period.", "no_campaign_data");
    const result = runAudit(input);
    const payload = toSaveAuditPayload(result, {
      title: title || `Advertising audit ${periodStart} to ${periodEnd}`,
      periodStart,
      periodEnd,
      adAccountIds: accounts.map((account) => account.id),
    });
    const now = new Date().toISOString();
    const run: AuditRun = {
      id: newId(),
      tenant_id: tenantId,
      title: payload.run.title,
      period_start: periodStart,
      period_end: periodEnd,
      status: "draft",
      engine_version: payload.run.engine_version,
      overall_score: payload.run.overall_score,
      platform_scores: result.platformScores,
      category_scores: payload.run.category_scores,
      kpis: payload.run.kpis,
      summary: payload.run.summary,
      ad_account_ids: payload.run.ad_account_ids,
      reviewed_at: null,
      published_at: null,
      created_at: now,
      updated_at: now,
    };
    state.runs.unshift(run);
    payload.findings.forEach((finding, index) => {
      state.findings.push({
        id: newId(),
        tenant_id: tenantId,
        audit_run_id: run.id,
        ad_account_id: finding.ad_account_id,
        campaign_id: finding.campaign_id,
        rule_id: finding.rule_id,
        category: finding.category,
        platform: finding.platform as Provider | null,
        severity: finding.severity as AuditFinding["severity"],
        title: finding.title,
        description: finding.description,
        recommendation: finding.recommendation,
        evidence: finding.evidence,
        estimated_impact: finding.estimated_impact,
        impact_currency: finding.impact_currency,
        status: "open",
        reviewer_note: null,
        sort_order: index + 1,
      });
    });
    return run;
  }

  function setStatus(run: AuditRun, status: AuditStatus) {
    const allowed =
      (run.status === "draft" && ["in_review", "published"].includes(status))
      || (run.status === "in_review" && ["draft", "published"].includes(status))
      || (run.status === "published" && status === "archived");
    if (!allowed) throw new ApiError(`Audit cannot move from ${run.status} to ${status}`, "22023");
    run.status = status;
    run.updated_at = new Date().toISOString();
    if (status === "published") {
      run.published_at = run.updated_at;
      run.reviewed_at = run.updated_at;
    }
  }

  async function renderReport(report: Report) {
    const run = state.runs.find((item) => item.id === report.audit_run_id);
    if (!run) throw new ApiError("The audit for this report no longer exists.", "not_found");
    const tenant = tenantOrThrow(run.tenant_id);
    const ids = new Set(run.ad_account_ids);
    return buildAuditReportPdf(toReportData({
      tenantName: tenant.business_name,
      run: { ...run, platform_scores: run.platform_scores as Record<string, number>, kpis: run.kpis as AuditRun["kpis"] & Record<string, unknown> },
      findings: state.findings.filter((finding) => finding.audit_run_id === run.id),
      campaigns: campaignPerformance(run.tenant_id, { from: run.period_start, to: run.period_end }).filter((row) => ids.has(row.ad_account_id)),
      synthetic: true,
    }));
  }

  // Seed: one published audit with a shared report, one draft under review.
  const lastDay = isoDate(new Date(Date.now() - 86_400_000));
  const seeded = createRun(DEMO_TENANT_IDS.northwind, addDays(lastDay, -29), lastDay, undefined, "Q4 performance audit");
  setStatus(seeded, "published");
  state.reports.push({
    id: newId(),
    tenant_id: seeded.tenant_id,
    audit_run_id: seeded.id,
    report_name: "Northwind Dental (Demo) - Q4 performance audit",
    report_type: "audit_pdf",
    storage_path: `${seeded.tenant_id}/demo.pdf`,
    status: "ready",
    visibility: "client",
    file_size_bytes: 48_000,
    error_message: null,
    generated_at: seeded.published_at,
    published_at: seeded.published_at,
    created_at: seeded.published_at ?? seeded.created_at,
  });
  const draft = createRun(DEMO_TENANT_IDS.harbor, addDays(lastDay, -29), lastDay, undefined, "Onboarding audit");
  setStatus(draft, "in_review");
  log("audit_runs.insert", seeded.tenant_id, "audit_runs", seeded.id);
  log("reports.update", seeded.tenant_id, "reports", state.reports[0].id);

  return {
    mode: "demo",

    async getPlatformOverview() {
      await wait();
      return {
        tenants: {
          total: state.tenants.length,
          active: state.tenants.filter((tenant) => tenant.status === "active").length,
          inactive: state.tenants.filter((tenant) => tenant.status === "inactive").length,
          suspended: state.tenants.filter((tenant) => tenant.status === "suspended").length,
        },
        connections: {
          total: state.connections.length,
          connected: state.connections.filter((item) => item.status === "connected").length,
          attention: state.connections.filter((item) => item.status === "expired" || item.status === "error").length,
        },
        ad_accounts: { total: state.accounts.length, syncing: state.accounts.filter((item) => item.sync_enabled).length },
        audits: {
          draft: state.runs.filter((run) => run.status === "draft").length,
          in_review: state.runs.filter((run) => run.status === "in_review").length,
          published: state.runs.filter((run) => run.status === "published").length,
        },
        reports: {
          ready: state.reports.filter((report) => report.status === "ready").length,
          shared: state.reports.filter((report) => report.visibility === "client").length,
          failed: state.reports.filter((report) => report.status === "failed").length,
        },
        sync: {
          running: state.jobs.filter((job) => job.status === "pending" || job.status === "processing").length,
          failed_7d: state.jobs.filter((job) => job.status === "failed").length,
          last_completed_at: state.jobs.find((job) => job.status === "completed")?.completed_at ?? null,
        },
      };
    },

    async listTenants() {
      await wait();
      return [...state.tenants].sort((a, b) => a.business_name.localeCompare(b.business_name));
    },

    async getTenant(tenantId) {
      await wait(120);
      return state.tenants.find((tenant) => tenant.id === tenantId) ?? null;
    },

    async createTenant(input) {
      await wait();
      if (state.tenants.some((tenant) => tenant.slug === input.slug)) throw new ApiError("That value is already in use.", "23505");
      const now = new Date().toISOString();
      const tenant: Tenant = { id: newId(), ...input, status: "active", created_at: now, updated_at: now };
      state.tenants.push(tenant);
      state.members[tenant.id] = [];
      log("tenants.insert", tenant.id, "tenants", tenant.id);
      return tenant;
    },

    async updateTenant(tenantId, patch) {
      await wait();
      Object.assign(tenantOrThrow(tenantId), patch, { updated_at: new Date().toISOString() });
      log("tenants.update", tenantId, "tenants", tenantId);
    },

    async listMembers(tenantId) {
      await wait();
      return state.members[tenantId] ?? [];
    },

    async listInvitations(tenantId) {
      await wait();
      return state.invitations.filter((invitation) => invitation.tenant_id === tenantId);
    },

    async inviteMember(tenantId, email, role) {
      await wait(400);
      for (const invitation of state.invitations) {
        if (invitation.tenant_id === tenantId && invitation.email === email && invitation.status === "pending") invitation.status = "revoked";
      }
      state.invitations.unshift({
        id: newId(),
        tenant_id: tenantId,
        email: email.toLowerCase(),
        role,
        status: "pending",
        expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        created_at: new Date().toISOString(),
      });
      log("tenant_invitations.insert", tenantId, "tenant_invitations", null);
    },

    async revokeInvitation(invitationId) {
      await wait();
      const invitation = state.invitations.find((item) => item.id === invitationId);
      if (!invitation || invitation.status !== "pending") throw new ApiError("Invitation is not pending", "22023");
      invitation.status = "revoked";
    },

    async changeMemberRole(tenantId, userId, role) {
      await wait();
      const members = state.members[tenantId] ?? [];
      const member = members.find((item) => item.user_id === userId);
      if (!member) throw new ApiError("Membership not found.", "22023");
      if (member.role === "owner" && role !== "owner" && members.filter((item) => item.role === "owner" && item.status === "active").length === 1) {
        throw new ApiError("A tenant must keep at least one active owner", "23514");
      }
      member.role = role;
    },

    async deactivateMember(tenantId, userId) {
      await wait();
      const members = state.members[tenantId] ?? [];
      const member = members.find((item) => item.user_id === userId);
      if (!member) throw new ApiError("Membership not found.", "22023");
      if (member.role === "owner" && members.filter((item) => item.role === "owner" && item.status === "active").length === 1) {
        throw new ApiError("A tenant must keep at least one active owner", "23514");
      }
      member.status = "inactive";
    },

    async getIntegrationStatus() {
      await wait(150);
      return {
        state: "available",
        providers: {
          meta: { configured: true, missing: [], apiVersion: "demo" },
          google: { configured: true, missing: [], apiVersion: "demo" },
        },
      };
    },

    async listConnections(tenantId) {
      await wait();
      return state.connections.filter((connection) => !tenantId || connection.tenant_id === tenantId);
    },

    async listAdAccounts(tenantId) {
      await wait();
      return state.accounts.filter((account) => !tenantId || account.tenant_id === tenantId);
    },

    async startOAuth(tenantId, provider) {
      await wait(300);
      const params = new URLSearchParams({ code: "demo-code", state: `demo:${tenantId}:${provider}` });
      return { authorizeUrl: `/oauth/callback?${params}` };
    },

    async completeOAuth(_code, stateValue) {
      await wait(700);
      const [, tenantId, provider] = stateValue.split(":");
      if (!tenantId || (provider !== "meta" && provider !== "google")) throw new ApiError("The connection request expired or was already used.", "invalid_state");
      tenantOrThrow(tenantId);
      const now = new Date().toISOString();
      const connection: Connection = {
        id: newId(),
        tenant_id: tenantId,
        provider,
        provider_account_id: null,
        account_name: provider === "meta" ? "Demo Meta login" : "Google Ads",
        status: "connected",
        token_expires_at: null,
        scopes: null,
        created_at: now,
        updated_at: now,
      };
      state.connections.unshift(connection);
      state.accounts.push({
        id: newId(),
        tenant_id: tenantId,
        connection_id: connection.id,
        provider,
        external_account_id: provider === "meta" ? `act_9${Date.now()}` : String(Date.now()).slice(-10),
        account_name: `${provider === "meta" ? "Meta" : "Google Ads"} account (Demo)`,
        currency: "INR",
        timezone: "Asia/Kolkata",
        status: "active",
        sync_enabled: false,
        last_synced_at: null,
      });
      log("oauth_connections.insert", tenantId, "oauth_connections", connection.id);
      emit("ad_accounts");
      return { connectionId: connection.id, tenantId, provider, accountsDiscovered: 1, warning: null };
    },

    async disconnect(connectionId) {
      await wait();
      const connection = state.connections.find((item) => item.id === connectionId);
      if (!connection) throw new ApiError("That connection no longer exists.", "connection_not_found");
      connection.status = "revoked";
      for (const account of state.accounts) if (account.connection_id === connectionId) account.sync_enabled = false;
      log("oauth_connections.update", connection.tenant_id, "oauth_connections", connection.id);
      emit("ad_accounts");
    },

    async setAdAccountSync(connectionId, adAccountIds) {
      await wait();
      let count = 0;
      for (const account of state.accounts) {
        if (account.connection_id !== connectionId) continue;
        account.sync_enabled = adAccountIds.includes(account.id);
        if (account.sync_enabled) count++;
      }
      emit("ad_accounts");
      return count;
    },

    async startSync(connectionId, jobType = "manual_sync") {
      await wait();
      const connection = state.connections.find((item) => item.id === connectionId);
      if (!connection || connection.status !== "connected") throw new ApiError("The sync could not be started.", "sync_not_started");
      if (state.jobs.some((job) => job.connection_id === connectionId && (job.status === "pending" || job.status === "processing"))) {
        throw new ApiError("A sync is already queued or running for this connection.", "sync_in_progress");
      }
      const job: SyncJob = {
        id: newId(),
        tenant_id: connection.tenant_id,
        connection_id: connectionId,
        provider: connection.provider,
        job_type: jobType,
        status: "processing",
        attempts: 1,
        started_at: new Date().toISOString(),
        completed_at: null,
        error_message: null,
        created_at: new Date().toISOString(),
      };
      state.jobs.unshift(job);
      emit("sync_jobs");
      setTimeout(() => {
        job.status = "completed";
        job.completed_at = new Date().toISOString();
        for (const account of state.accounts) {
          if (account.connection_id === connectionId && account.sync_enabled) account.last_synced_at = job.completed_at;
        }
        emit("sync_jobs");
        emit("ad_accounts");
      }, 2500);
      return { jobId: job.id };
    },

    async listSyncJobs(tenantId) {
      await wait();
      return state.jobs.filter((job) => !tenantId || job.tenant_id === tenantId);
    },

    async getTenantSyncStatus(tenantId) {
      await wait(120);
      const byProvider = new Map<Provider, SyncJob[]>();
      for (const job of state.jobs.filter((item) => item.tenant_id === tenantId)) {
        byProvider.set(job.provider, [...(byProvider.get(job.provider) ?? []), job]);
      }
      return [...byProvider.entries()].map(([provider, jobs]) => ({
        provider,
        last_status: jobs[0].status,
        last_run_at: jobs[0].completed_at ?? jobs[0].started_at,
        last_successful_sync_at: jobs.find((job) => job.status === "completed")?.completed_at ?? null,
      }));
    },

    async getCampaignPerformance(tenantId, range, adAccountId) {
      await wait();
      return campaignPerformance(tenantId, range, adAccountId);
    },

    async getDailyPerformance(tenantId, range, adAccountId) {
      await wait();
      return dailyPerformance(tenantId, range, adAccountId);
    },

    async listAuditRuns(tenantId) {
      await wait();
      return state.runs.filter((run) => !tenantId || run.tenant_id === tenantId);
    },

    async getAuditRun(auditRunId) {
      await wait(120);
      return state.runs.find((run) => run.id === auditRunId) ?? null;
    },

    async listFindings(auditRunId) {
      await wait();
      return state.findings.filter((finding) => finding.audit_run_id === auditRunId).sort((a, b) => a.sort_order - b.sort_order);
    },

    async runAudit(input) {
      await wait(900);
      const run = createRun(input.tenantId, input.periodStart, input.periodEnd, input.adAccountIds, input.title);
      log("audit_runs.insert", run.tenant_id, "audit_runs", run.id);
      emit("audit_runs");
      return { auditRunId: run.id };
    },

    async updateFinding(findingId, patch) {
      await wait(150);
      const finding = state.findings.find((item) => item.id === findingId);
      if (!finding) throw new ApiError("Finding not found.", "not_found");
      const run = state.runs.find((item) => item.id === finding.audit_run_id);
      if (run && (run.status === "published" || run.status === "archived")) throw new ApiError("Findings of a published audit are immutable", "42501");
      Object.assign(finding, patch);
    },

    async setAuditStatus(auditRunId, status, summary) {
      await wait();
      const run = state.runs.find((item) => item.id === auditRunId);
      if (!run) throw new ApiError("Unknown audit.", "22023");
      if (summary !== undefined && (run.status === "draft" || run.status === "in_review")) run.summary = summary.trim() || null;
      setStatus(run, status);
      log(`audit_runs.update`, run.tenant_id, "audit_runs", run.id);
      emit("audit_runs");
    },

    async updateAuditSummary(auditRunId, summary) {
      await wait(150);
      const run = state.runs.find((item) => item.id === auditRunId);
      if (!run || (run.status !== "draft" && run.status !== "in_review")) throw new ApiError("Published audits are immutable", "42501");
      run.summary = summary.trim() || null;
      emit("audit_runs");
    },

    async deleteAuditRun(auditRunId) {
      await wait();
      const run = state.runs.find((item) => item.id === auditRunId);
      if (!run) return;
      if (run.status === "published" || run.status === "archived") throw new ApiError("Published audits cannot be deleted; archive them instead", "42501");
      state.runs = state.runs.filter((item) => item.id !== auditRunId);
      state.findings = state.findings.filter((finding) => finding.audit_run_id !== auditRunId);
      emit("audit_runs");
    },

    async listReports(tenantId) {
      await wait();
      return state.reports.filter((report) => !tenantId || report.tenant_id === tenantId);
    },

    async generateReport(auditRunId, shareWithClient) {
      const run = state.runs.find((item) => item.id === auditRunId);
      if (!run) throw new ApiError("Unknown audit.", "audit_not_found");
      if (shareWithClient && run.status !== "published") throw new ApiError("Publish the audit before sharing its report with the client.", "audit_not_published");
      const tenant = tenantOrThrow(run.tenant_id);
      const report: Report = {
        id: newId(),
        tenant_id: run.tenant_id,
        audit_run_id: run.id,
        report_name: `${tenant.business_name} - ${run.title}`,
        report_type: "audit_pdf",
        storage_path: null,
        status: "generating",
        visibility: "internal",
        file_size_bytes: null,
        error_message: null,
        generated_at: null,
        published_at: null,
        created_at: new Date().toISOString(),
      };
      state.reports.unshift(report);
      emit("reports");
      const pdf = await renderReport(report);
      await wait(500);
      report.status = "ready";
      report.storage_path = `${run.tenant_id}/${report.id}.pdf`;
      report.file_size_bytes = pdf.byteLength;
      report.generated_at = new Date().toISOString();
      if (shareWithClient) {
        report.visibility = "client";
        report.published_at = report.generated_at;
      }
      log("reports.insert", run.tenant_id, "reports", report.id);
      emit("reports");
      return { reportId: report.id };
    },

    async setReportVisibility(reportId, visibility) {
      await wait();
      const report = state.reports.find((item) => item.id === reportId);
      if (!report) throw new ApiError("Report not found.", "not_found");
      const run = state.runs.find((item) => item.id === report.audit_run_id);
      if (visibility === "client" && run && run.status !== "published") throw new ApiError("Publish the audit before sharing its report", "23514");
      report.visibility = visibility;
      report.published_at = visibility === "client" ? new Date().toISOString() : null;
      emit("reports");
    },

    async deleteReport(report) {
      await wait();
      state.reports = state.reports.filter((item) => item.id !== report.id);
      emit("reports");
    },

    async downloadReport(report) {
      const pdf = await renderReport(report);
      const url = URL.createObjectURL(new Blob([pdf as BlobPart], { type: "application/pdf" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${report.report_name.replace(/[^\w.-]+/g, "_")}-SYNTHETIC-DEMO.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },

    async listActivity(tenantId) {
      await wait();
      return state.activity.filter((entry) => !tenantId || entry.tenant_id === tenantId);
    },

    subscribe(tables, onChange) {
      const key = ++listenerId;
      listeners.set(key, { tables, onChange });
      return () => {
        listeners.delete(key);
      };
    },
  };
}

export { DEMO_USERS };
