import type { AuditResult } from "@functions/_shared/audit/types.ts";
import type { TenantRole } from "../auth-context";

export type Provider = "meta" | "google";
export type TenantStatus = "active" | "inactive" | "suspended";
export type ConnectionStatus = "pending" | "connected" | "expired" | "revoked" | "error";
export type AuditStatus = "draft" | "in_review" | "published" | "archived";
export type FindingStatus = "open" | "accepted" | "dismissed" | "resolved";
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type ReportStatus = "pending" | "generating" | "ready" | "failed";
export type ReportVisibility = "internal" | "client";
export type SyncStatus = "pending" | "processing" | "completed" | "failed";

export type Tenant = {
  id: string;
  business_name: string;
  slug: string;
  email: string | null;
  status: TenantStatus;
  industry: string | null;
  website: string | null;
  primary_contact_name: string | null;
  created_at: string;
  updated_at: string;
};

export type TenantInput = {
  business_name: string;
  slug: string;
  email: string | null;
  industry: string | null;
  website: string | null;
  primary_contact_name: string | null;
};

export type PlatformOverview = {
  tenants: { total: number; active: number; inactive: number; suspended: number };
  connections: { total: number; connected: number; attention: number };
  ad_accounts: { total: number; syncing: number };
  audits: { draft: number; in_review: number; published: number };
  reports: { ready: number; shared: number; failed: number };
  sync: { running: number; failed_7d: number; last_completed_at: string | null };
};

export type Member = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  role: TenantRole;
  status: "active" | "inactive" | "invited";
  created_at: string;
  updated_at: string;
};

export type Invitation = {
  id: string;
  tenant_id: string;
  email: string;
  role: TenantRole;
  status: "pending" | "accepted" | "revoked" | "expired";
  expires_at: string;
  created_at: string;
};

export type ProviderAvailability = {
  configured: boolean;
  missing: string[];
  apiVersion: string;
};

export type IntegrationStatus =
  | { state: "available"; providers: Record<Provider, ProviderAvailability> }
  | { state: "service_unavailable"; message: string };

export type Connection = {
  id: string;
  tenant_id: string;
  provider: Provider;
  provider_account_id: string | null;
  account_name: string | null;
  status: ConnectionStatus;
  token_expires_at: string | null;
  scopes: string[] | null;
  created_at: string;
  updated_at: string;
};

export type AdAccount = {
  id: string;
  tenant_id: string;
  connection_id: string | null;
  provider: Provider;
  external_account_id: string;
  account_name: string | null;
  currency: string | null;
  timezone: string | null;
  status: string | null;
  sync_enabled: boolean;
  last_synced_at: string | null;
};

export type SyncJob = {
  id: string;
  tenant_id: string;
  connection_id: string | null;
  provider: Provider;
  job_type: "daily_sync" | "backfill" | "manual_sync";
  status: SyncStatus;
  attempts: number;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  created_at: string;
};

export type TenantSyncStatus = {
  provider: Provider;
  last_status: SyncStatus;
  last_run_at: string | null;
  last_successful_sync_at: string | null;
};

export type DateRange = { from: string; to: string };

export type CampaignPerformance = {
  campaign_id: string;
  ad_account_id: string;
  provider: Provider;
  account_name: string | null;
  external_campaign_id: string;
  campaign_name: string | null;
  objective: string | null;
  campaign_status: string | null;
  channel_type: string | null;
  bid_strategy: string | null;
  daily_budget: number | null;
  currency: string | null;
  impressions: number;
  reach: number;
  clicks: number;
  spend: number;
  conversions: number;
  conversion_value: number;
  active_days: number;
};

export type DailyPerformance = {
  metric_date: string;
  ad_account_id: string;
  provider: Provider;
  currency: string | null;
  impressions: number;
  reach: number;
  clicks: number;
  spend: number;
  conversions: number;
  conversion_value: number;
};

export type AuditRun = {
  id: string;
  tenant_id: string;
  title: string;
  period_start: string;
  period_end: string;
  status: AuditStatus;
  engine_version: string;
  overall_score: number | null;
  platform_scores: Partial<Record<Provider, number>>;
  category_scores: Record<string, number>;
  kpis: Partial<AuditResult["kpis"]>;
  summary: string | null;
  ad_account_ids: string[];
  reviewed_at: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AuditFinding = {
  id: string;
  tenant_id: string;
  audit_run_id: string;
  ad_account_id: string | null;
  campaign_id: string | null;
  rule_id: string;
  category: string;
  platform: Provider | null;
  severity: Severity;
  title: string;
  description: string;
  recommendation: string;
  evidence: Record<string, unknown>;
  estimated_impact: number | null;
  impact_currency: string | null;
  status: FindingStatus;
  reviewer_note: string | null;
  sort_order: number;
};

export type FindingPatch = Partial<Pick<AuditFinding, "status" | "severity" | "reviewer_note">>;

export type RunAuditInput = {
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  adAccountIds?: string[];
  title?: string;
};

export type Report = {
  id: string;
  tenant_id: string;
  audit_run_id: string | null;
  report_name: string;
  report_type: string | null;
  storage_path: string | null;
  status: ReportStatus;
  visibility: ReportVisibility;
  file_size_bytes: number | null;
  error_message: string | null;
  generated_at: string | null;
  published_at: string | null;
  created_at: string;
};

export type ActivityEntry = {
  id: string;
  tenant_id: string | null;
  user_id: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  created_at: string;
  actor_email: string | null;
};

export type OAuthCompletion = {
  connectionId: string;
  tenantId: string;
  provider: Provider;
  accountsDiscovered: number;
  warning: string | null;
};

export type RealtimeTable = "sync_jobs" | "ad_accounts" | "audit_runs" | "reports";

export interface PortalApi {
  readonly mode: "live" | "demo";

  // Staff overview and clients
  getPlatformOverview(): Promise<PlatformOverview>;
  listTenants(): Promise<Tenant[]>;
  getTenant(tenantId: string): Promise<Tenant | null>;
  createTenant(input: TenantInput): Promise<Tenant>;
  updateTenant(tenantId: string, patch: Partial<TenantInput> & { status?: TenantStatus }): Promise<void>;

  // Members and invitations
  listMembers(tenantId: string): Promise<Member[]>;
  listInvitations(tenantId: string): Promise<Invitation[]>;
  inviteMember(tenantId: string, email: string, role: TenantRole): Promise<void>;
  revokeInvitation(invitationId: string): Promise<void>;
  changeMemberRole(tenantId: string, userId: string, role: TenantRole): Promise<void>;
  deactivateMember(tenantId: string, userId: string): Promise<void>;

  // Connections and sync
  getIntegrationStatus(): Promise<IntegrationStatus>;
  listConnections(tenantId?: string): Promise<Connection[]>;
  listAdAccounts(tenantId?: string): Promise<AdAccount[]>;
  startOAuth(tenantId: string, provider: Provider): Promise<{ authorizeUrl: string }>;
  completeOAuth(code: string, state: string): Promise<OAuthCompletion>;
  disconnect(connectionId: string): Promise<void>;
  setAdAccountSync(connectionId: string, adAccountIds: string[]): Promise<number>;
  startSync(connectionId: string, jobType?: "manual_sync" | "backfill"): Promise<{ jobId: string }>;
  listSyncJobs(tenantId?: string): Promise<SyncJob[]>;
  getTenantSyncStatus(tenantId: string): Promise<TenantSyncStatus[]>;

  // Analytics
  getCampaignPerformance(tenantId: string, range: DateRange, adAccountId?: string): Promise<CampaignPerformance[]>;
  getDailyPerformance(tenantId: string, range: DateRange, adAccountId?: string): Promise<DailyPerformance[]>;

  // Audits
  listAuditRuns(tenantId?: string): Promise<AuditRun[]>;
  getAuditRun(auditRunId: string): Promise<AuditRun | null>;
  listFindings(auditRunId: string): Promise<AuditFinding[]>;
  runAudit(input: RunAuditInput): Promise<{ auditRunId: string }>;
  updateFinding(findingId: string, patch: FindingPatch): Promise<void>;
  setAuditStatus(auditRunId: string, status: AuditStatus, summary?: string): Promise<void>;
  updateAuditSummary(auditRunId: string, summary: string): Promise<void>;
  deleteAuditRun(auditRunId: string): Promise<void>;

  // Reports
  listReports(tenantId?: string): Promise<Report[]>;
  generateReport(auditRunId: string, shareWithClient: boolean): Promise<{ reportId: string }>;
  setReportVisibility(reportId: string, visibility: ReportVisibility): Promise<void>;
  deleteReport(report: Report): Promise<void>;
  downloadReport(report: Report): Promise<void>;

  // Activity
  listActivity(tenantId?: string): Promise<ActivityEntry[]>;

  // Realtime: returns an unsubscribe function
  subscribe(tables: RealtimeTable[], onChange: () => void): () => void;
}
