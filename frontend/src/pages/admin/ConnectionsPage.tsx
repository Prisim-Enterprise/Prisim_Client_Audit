import { useQuery } from "@tanstack/react-query";
import { Link2, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { Alert } from "../../components/ui/Alert";
import { ProviderBadge, StatusBadge, statusLabel } from "../../components/ui/Badge";
import { Card } from "../../components/ui/Card";
import { EmptyState, PageHeader, QueryView, SectionCard } from "../../components/ui/States";
import { formatDateTime, relativeTime } from "../../lib/analytics";
import { queryKeys, useApi, useRealtime } from "../../lib/api/ApiProvider";

export function ConnectionsPage() {
  const api = useApi();
  useRealtime(["sync_jobs", "ad_accounts"]);
  const tenants = useQuery({ queryKey: queryKeys.tenants, queryFn: () => api.listTenants() });
  const connections = useQuery({ queryKey: queryKeys.connections(), queryFn: () => api.listConnections() });
  const accounts = useQuery({ queryKey: queryKeys.adAccounts(), queryFn: () => api.listAdAccounts() });
  const jobs = useQuery({ queryKey: queryKeys.syncJobs(), queryFn: () => api.listSyncJobs() });
  const integrations = useQuery({ queryKey: queryKeys.integrations, queryFn: () => api.getIntegrationStatus(), staleTime: 5 * 60_000 });
  const names = new Map((tenants.data ?? []).map((tenant) => [tenant.id, tenant.business_name]));

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Connections" title="Ad platform connections" description="Meta and Google Ads access across all clients. Tokens are stored in Supabase Vault and never reach the browser." />

      {integrations.data && (
        <div className="grid gap-3 md:grid-cols-2">
          {integrations.data.state === "service_unavailable" ? (
            <Alert tone="info" title="Connection service unavailable" className="md:col-span-2">{integrations.data.message}</Alert>
          ) : (
            (["meta", "google"] as const).map((provider) => {
              const status = integrations.data.state === "available" ? integrations.data.providers[provider] : null;
              return (
                <Card key={provider} className="flex items-center justify-between gap-3 p-4">
                  <div>
                    <ProviderBadge provider={provider} />
                    <p className="mt-1 text-xs text-slate-500">
                      {status?.configured ? `API ${status.apiVersion} · credentials configured` : `Missing: ${status?.missing.join(", ")}`}
                    </p>
                  </div>
                  <StatusBadge status={status?.configured ? "active" : "pending"} />
                </Card>
              );
            })
          )}
        </div>
      )}

      <SectionCard title="Connections">
        <QueryView query={connections} empty={<EmptyState icon={<Link2 />} title="No connections yet" description="Connect ad accounts from a client's Connections tab, or let the client connect them in their portal." />}>
          {(items) => (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className="px-5 py-3 font-medium">Client</th>
                    <th scope="col" className="px-3 py-3 font-medium">Platform</th>
                    <th scope="col" className="px-3 py-3 font-medium">Status</th>
                    <th scope="col" className="px-3 py-3 text-right font-medium">Syncing accounts</th>
                    <th scope="col" className="px-3 py-3 font-medium">Last data</th>
                    <th scope="col" className="px-5 py-3 font-medium">Access expires</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.filter((item) => item.status !== "revoked").map((connection) => {
                    const linked = (accounts.data ?? []).filter((account) => account.connection_id === connection.id);
                    const last = linked.map((account) => account.last_synced_at).filter(Boolean).sort().at(-1) ?? null;
                    return (
                      <tr key={connection.id} className="hover:bg-slate-50/70">
                        <td className="px-5 py-3">
                          <Link className="font-medium text-ink-950 hover:text-accent-700" to={`/admin/clients/${connection.tenant_id}?tab=connections`}>{names.get(connection.tenant_id) ?? "Client"}</Link>
                          <p className="text-xs text-slate-500">{connection.account_name ?? "–"}</p>
                        </td>
                        <td className="px-3 py-3"><ProviderBadge provider={connection.provider} /></td>
                        <td className="px-3 py-3"><StatusBadge status={connection.status} /></td>
                        <td className="px-3 py-3 text-right tabular-nums">{linked.filter((account) => account.sync_enabled).length} / {linked.length}</td>
                        <td className="px-3 py-3 text-slate-600">{relativeTime(last)}</td>
                        <td className="px-5 py-3 text-slate-600">{formatDateTime(connection.token_expires_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </QueryView>
      </SectionCard>

      <SectionCard title="Sync history" description="Latest 100 jobs. Errors are visible to PRISIM staff only.">
        <QueryView query={jobs} empty={<EmptyState icon={<RefreshCw />} title="No sync jobs yet" />}>
          {(items) => (
            <ul className="divide-y divide-slate-100">
              {items.map((job) => (
                <li key={job.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 sm:px-6">
                  <span className="w-36 shrink-0 text-xs tabular-nums text-slate-500">{formatDateTime(job.created_at)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink-950">{names.get(job.tenant_id) ?? "Client"}</span>
                    <span className="text-xs text-slate-500"><ProviderBadge provider={job.provider} /> · {statusLabel(job.job_type)} · attempt {job.attempts}</span>
                    {job.error_message && <span className="block text-xs text-rose-600">{job.error_message}</span>}
                  </span>
                  <StatusBadge status={job.status} />
                </li>
              ))}
            </ul>
          )}
        </QueryView>
      </SectionCard>
    </div>
  );
}
