import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ClipboardCheck, FileText } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { Alert } from "../../components/ui/Alert";
import { LoadingState } from "../../components/ui/LoadingState";
import { EmptyState, ErrorState, PageHeader, QueryView, SectionCard } from "../../components/ui/States";
import { useAuth } from "../../context/AuthProvider";
import { PerformancePanel } from "../../features/analytics/PerformancePanel";
import { AuditOverview, AuditRunTable, FindingsList } from "../../features/audits/AuditComponents";
import { ConnectionsPanel } from "../../features/connections/ConnectionsPanel";
import { ReportsTable } from "../../features/reports/ReportsTable";
import { TeamPanel } from "../../features/team/TeamPanel";
import { formatDate, formatDateTime } from "../../lib/analytics";
import { queryKeys, useApi, useRealtime } from "../../lib/api/ApiProvider";
import { roleAtLeast, useWorkspace } from "./workspace";

export function AdAccountsPage() {
  const workspace = useWorkspace();
  const canManage = roleAtLeast(workspace.role, "manager");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={workspace.business_name}
        title="Ad accounts"
        description={canManage
          ? "Connect Meta Ads and Google Ads with read-only access, choose which accounts PRISIM audits, and sync on demand."
          : "The advertising accounts connected to this workspace."}
      />
      <ConnectionsPanel tenantId={workspace.tenant_id} canManage={canManage} />
    </div>
  );
}

export function CampaignsPage() {
  const api = useApi();
  const workspace = useWorkspace();
  useRealtime(["ad_accounts"]);
  const accounts = useQuery({ queryKey: queryKeys.adAccounts(workspace.tenant_id), queryFn: () => api.listAdAccounts(workspace.tenant_id) });
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={workspace.business_name} title="Campaign analytics" description="Spend, results and efficiency for every synced campaign." />
      {accounts.isLoading ? <LoadingState /> : accounts.error ? <ErrorState error={accounts.error} /> : (
        <PerformancePanel tenantId={workspace.tenant_id} accounts={(accounts.data ?? []).filter((account) => account.sync_enabled)} />
      )}
    </div>
  );
}

export function ClientAuditsPage() {
  const api = useApi();
  const workspace = useWorkspace();
  useRealtime(["audit_runs"]);
  const runs = useQuery({ queryKey: queryKeys.auditRuns(workspace.tenant_id), queryFn: () => api.listAuditRuns(workspace.tenant_id) });
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={workspace.business_name} title="Audit findings" description="Audits reviewed and published by your PRISIM team." />
      <SectionCard title="Published audits">
        <QueryView query={runs} empty={<EmptyState icon={<ClipboardCheck />} title="No audits published yet" description="Your PRISIM team reviews every audit before it is published here." />}>
          {(items) => <AuditRunTable runs={items} linkTo={(run) => `${workspace.base}/audits/${run.id}`} />}
        </QueryView>
      </SectionCard>
    </div>
  );
}

export function ClientAuditDetailPage() {
  const api = useApi();
  const workspace = useWorkspace();
  const { auditId = "" } = useParams();
  const run = useQuery({ queryKey: queryKeys.auditRun(auditId), queryFn: () => api.getAuditRun(auditId) });
  const findings = useQuery({ queryKey: queryKeys.findings(auditId), queryFn: () => api.listFindings(auditId), enabled: Boolean(run.data) });
  const reports = useQuery({ queryKey: queryKeys.reports(workspace.tenant_id), queryFn: () => api.listReports(workspace.tenant_id) });

  if (run.isLoading) return <LoadingState label="Loading audit…" />;
  if (run.error) return <ErrorState error={run.error} />;
  if (!run.data || run.data.tenant_id !== workspace.tenant_id) {
    return <EmptyState title="Audit not available" description="It may have been archived." action={<Link className="text-sm font-medium text-accent-700" to={`${workspace.base}/audits`}>Back to audits</Link>} />;
  }
  const audit = run.data;
  const auditReports = (reports.data ?? []).filter((report) => report.audit_run_id === audit.id);
  return (
    <div className="space-y-6">
      <Link to={`${workspace.base}/audits`} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-ink-950">
        <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Audits
      </Link>
      <PageHeader
        eyebrow={workspace.business_name}
        title={audit.title}
        description={`${formatDate(audit.period_start)} – ${formatDate(audit.period_end)} · published ${formatDateTime(audit.published_at)}`}
      />
      <AuditOverview run={audit} />
      {auditReports.length > 0 && (
        <SectionCard title="Report"><ReportsTable reports={auditReports} /></SectionCard>
      )}
      <div>
        <h2 className="mb-3 text-lg font-semibold text-ink-950">Findings and recommendations</h2>
        <QueryView query={findings}>{(items) => <FindingsList findings={items} />}</QueryView>
      </div>
    </div>
  );
}

export function ClientReportsPage() {
  const api = useApi();
  const workspace = useWorkspace();
  useRealtime(["reports"]);
  const reports = useQuery({ queryKey: queryKeys.reports(workspace.tenant_id), queryFn: () => api.listReports(workspace.tenant_id) });
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={workspace.business_name} title="Reports" description="Professional audit reports shared by PRISIM. Download links are private and expire after one minute." />
      <SectionCard title="Your reports">
        <QueryView query={reports} empty={<EmptyState icon={<FileText />} title="No reports yet" description="Reports appear here once PRISIM shares an audit report with you." />}>
          {(items) => <ReportsTable reports={items} />}
        </QueryView>
      </SectionCard>
    </div>
  );
}

export function TeamPage() {
  const workspace = useWorkspace();
  const { user } = useAuth();
  if (!roleAtLeast(workspace.role, "admin")) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow={workspace.business_name} title="Team" />
        <Alert tone="info">Only workspace owners and admins can manage members.</Alert>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={workspace.business_name} title="Team" description="People with access to this workspace and their roles." />
      <TeamPanel tenantId={workspace.tenant_id} actorRole={workspace.role} currentUserId={user?.id ?? null} />
    </div>
  );
}
