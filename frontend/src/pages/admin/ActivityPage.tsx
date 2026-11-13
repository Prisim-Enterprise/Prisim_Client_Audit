import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { Card } from "../../components/ui/Card";
import { EmptyState, PageHeader, QueryView } from "../../components/ui/States";
import { formatDateTime } from "../../lib/analytics";
import { queryKeys, useApi } from "../../lib/api/ApiProvider";

const ENTITY_LABELS: Record<string, string> = {
  tenants: "Client",
  tenant_memberships: "Membership",
  tenant_invitations: "Invitation",
  platform_admins: "Staff access",
  oauth_connections: "Ad platform connection",
  oauth_credentials: "Connection credentials",
  ad_accounts: "Ad account",
  reports: "Report",
  audit_scores: "Audit score",
  audit_runs: "Audit",
  audit_findings: "Audit finding",
  sync_jobs: "Sync job",
  privileged_actions: "Authorized action",
  profiles: "Profile",
};

const VERBS: Record<string, string> = { insert: "created", update: "updated", delete: "deleted" };

export function describeActivity(action: string) {
  const [table, operation] = action.split(".");
  return `${ENTITY_LABELS[table] ?? table} ${VERBS[operation] ?? operation}`;
}

export function ActivityList({ tenantId }: { tenantId?: string }) {
  const api = useApi();
  const activity = useQuery({ queryKey: queryKeys.activity(tenantId), queryFn: () => api.listActivity(tenantId) });
  return (
    <QueryView query={activity} empty={<EmptyState icon={<Activity />} title="No activity recorded" description="Changes to clients, members, connections, audits and reports are recorded here automatically." />}>
      {(entries) => (
        <ul className="divide-y divide-slate-100">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 sm:px-6">
              <span className="w-36 shrink-0 text-xs tabular-nums text-slate-500">{formatDateTime(entry.created_at)}</span>
              <span className="min-w-0 flex-1 text-sm text-ink-950">{describeActivity(entry.action)}</span>
              <span className="text-xs text-slate-500">
                {entry.actor_email ?? (entry.actor_role === "service_role" ? "PRISIM system" : entry.actor_role ?? "system")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </QueryView>
  );
}

export function ActivityPage() {
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Activity" title="Audit trail" description="Append-only record written by the database. Secrets, token hashes and provider payloads are never recorded." />
      <Card className="overflow-hidden"><ActivityList /></Card>
    </div>
  );
}
