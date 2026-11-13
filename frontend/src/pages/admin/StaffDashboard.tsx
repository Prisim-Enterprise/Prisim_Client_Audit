import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowUpRight, Building2, ClipboardCheck, FileText, Link2, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { ProviderBadge, StatusBadge } from "../../components/ui/Badge";
import { EmptyState, ErrorState, PageHeader, QueryView, SectionCard, StatTile } from "../../components/ui/States";
import { LoadingState } from "../../components/ui/LoadingState";
import { useAuth } from "../../context/AuthProvider";
import { AuditRunTable, RunAuditButton } from "../../features/audits/AuditComponents";
import { relativeTime } from "../../lib/analytics";
import { queryKeys, useApi, useRealtime } from "../../lib/api/ApiProvider";

export function StaffDashboard() {
  const api = useApi();
  const { user, profile } = useAuth();
  useRealtime(["sync_jobs", "audit_runs", "reports"]);
  const name = profile?.full_name?.trim().split(/\s+/)[0] || user?.email?.split("@")[0] || "there";

  const overview = useQuery({ queryKey: queryKeys.overview, queryFn: () => api.getPlatformOverview() });
  const tenants = useQuery({ queryKey: queryKeys.tenants, queryFn: () => api.listTenants() });
  const runs = useQuery({ queryKey: queryKeys.auditRuns(), queryFn: () => api.listAuditRuns() });
  const jobs = useQuery({ queryKey: queryKeys.syncJobs(), queryFn: () => api.listSyncJobs() });
  const connections = useQuery({ queryKey: queryKeys.connections(), queryFn: () => api.listConnections() });

  const awaitingReview = (runs.data ?? []).filter((run) => run.status === "draft" || run.status === "in_review");
  const attention = (connections.data ?? []).filter((connection) => connection.status === "expired" || connection.status === "error");
  const tenantName = new Map((tenants.data ?? []).map((tenant) => [tenant.id, tenant.business_name]));

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Staff workspace"
        title={`Good to see you, ${name}`}
        description="Client onboarding, ad platform health and audits awaiting review."
        actions={<RunAuditButton />}
      />

      {overview.error ? (
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      ) : overview.isLoading || !overview.data ? (
        <LoadingState label="Loading overview…" />
      ) : (
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile label="Active clients" value={overview.data.tenants.active} icon={<Building2 />} detail={`${overview.data.tenants.total} total · ${overview.data.tenants.suspended} suspended`} />
          <StatTile
            label="Connections"
            value={overview.data.connections.connected}
            icon={<Link2 />}
            tone={overview.data.connections.attention > 0 ? "warning" : "default"}
            detail={`${overview.data.ad_accounts.syncing} of ${overview.data.ad_accounts.total} ad accounts syncing · ${overview.data.connections.attention} need attention`}
          />
          <StatTile label="Audits to review" value={overview.data.audits.draft + overview.data.audits.in_review} icon={<ClipboardCheck />} detail={`${overview.data.audits.published} published`} />
          <StatTile
            label="Reports"
            value={overview.data.reports.ready}
            icon={<FileText />}
            detail={`${overview.data.reports.shared} shared with clients · last sync ${relativeTime(overview.data.sync.last_completed_at)}`}
          />
        </section>
      )}

      <div className="grid gap-5 xl:grid-cols-[1.5fr_1fr]">
        <SectionCard
          title="Awaiting review"
          description="Draft and in-review audits are not visible to clients."
          actions={<Link to="/admin/audits" className="inline-flex items-center gap-1 text-sm font-medium text-accent-700">All audits <ArrowUpRight aria-hidden="true" className="h-4 w-4" /></Link>}
        >
          <QueryView query={runs} isEmpty={() => awaitingReview.length === 0} empty={<EmptyState icon={<ClipboardCheck />} title="Nothing to review" description="Run an audit for a client to create a draft." />}>
            {() => <AuditRunTable runs={awaitingReview.slice(0, 8)} tenants={tenants.data} linkTo={(run) => `/admin/audits/${run.id}`} />}
          </QueryView>
        </SectionCard>

        <div className="space-y-5">
          <SectionCard title="Needs attention">
            <QueryView query={connections} isEmpty={() => attention.length === 0} empty={<EmptyState title="All connections healthy" description="Expired or failing connections appear here." />}>
              {() => (
                <ul className="divide-y divide-slate-100">
                  {attention.map((connection) => (
                    <li key={connection.id} className="flex items-center gap-3 px-5 py-3">
                      <AlertTriangle aria-hidden="true" className="h-4 w-4 text-amber-600" />
                      <div className="min-w-0 flex-1">
                        <Link to={`/admin/clients/${connection.tenant_id}?tab=connections`} className="block truncate text-sm font-medium text-ink-950 hover:text-accent-700">
                          {tenantName.get(connection.tenant_id) ?? "Client"}
                        </Link>
                        <ProviderBadge provider={connection.provider} />
                      </div>
                      <StatusBadge status={connection.status} />
                    </li>
                  ))}
                </ul>
              )}
            </QueryView>
          </SectionCard>
          <SectionCard
            title="Recent syncs"
            actions={<Link to="/admin/connections" className="text-sm font-medium text-accent-700">View all</Link>}
          >
            <QueryView query={jobs} empty={<EmptyState icon={<RefreshCw />} title="No syncs yet" />}>
              {(items) => (
                <ul className="divide-y divide-slate-100">
                  {items.slice(0, 6).map((job) => (
                    <li key={job.id} className="flex items-center gap-3 px-5 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-ink-950">{tenantName.get(job.tenant_id) ?? "Client"}</p>
                        <p className="text-xs text-slate-500"><ProviderBadge provider={job.provider} /> · {relativeTime(job.completed_at ?? job.started_at ?? job.created_at)}</p>
                      </div>
                      <StatusBadge status={job.status} />
                    </li>
                  ))}
                </ul>
              )}
            </QueryView>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
