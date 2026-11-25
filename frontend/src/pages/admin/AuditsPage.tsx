import { useQuery } from "@tanstack/react-query";
import { ClipboardCheck, FileText } from "lucide-react";
import { useState } from "react";
import { Tabs } from "../../components/ui/Controls";
import { EmptyState, PageHeader, QueryView, SectionCard } from "../../components/ui/States";
import { AuditRunTable, RunAuditButton } from "../../features/audits/AuditComponents";
import { ReportsTable } from "../../features/reports/ReportsTable";
import { queryKeys, useApi, useRealtime } from "../../lib/api/ApiProvider";
import type { AuditStatus } from "../../lib/api/types";

export function AuditsPage() {
  const api = useApi();
  useRealtime(["audit_runs"]);
  const [filter, setFilter] = useState<"review" | AuditStatus>("review");
  const tenants = useQuery({ queryKey: queryKeys.tenants, queryFn: () => api.listTenants() });
  const runs = useQuery({ queryKey: queryKeys.auditRuns(), queryFn: () => api.listAuditRuns() });
  const all = runs.data ?? [];
  const visible = all.filter((run) => (filter === "review" ? run.status === "draft" || run.status === "in_review" : run.status === filter));
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Audits" title="Advertising audits" description="Engine-generated drafts are reviewed by PRISIM, then published to the client." actions={<RunAuditButton />} />
      <Tabs
        label="Audit status"
        value={filter}
        onChange={setFilter}
        items={[
          { value: "review", label: "To review", count: all.filter((run) => run.status === "draft" || run.status === "in_review").length },
          { value: "published", label: "Published", count: all.filter((run) => run.status === "published").length },
          { value: "archived", label: "Archived", count: all.filter((run) => run.status === "archived").length },
        ]}
      />
      <SectionCard title={filter === "review" ? "Awaiting review" : filter === "published" ? "Published audits" : "Archived audits"}>
        <QueryView query={runs} isEmpty={() => visible.length === 0} empty={<EmptyState icon={<ClipboardCheck />} title="No audits here" />}>
          {() => <AuditRunTable runs={visible} tenants={tenants.data} linkTo={(run) => `/admin/audits/${run.id}`} />}
        </QueryView>
      </SectionCard>
    </div>
  );
}

export function ReportsPage() {
  const api = useApi();
  useRealtime(["reports"]);
  const tenants = useQuery({ queryKey: queryKeys.tenants, queryFn: () => api.listTenants() });
  const reports = useQuery({ queryKey: queryKeys.reports(), queryFn: () => api.listReports() });
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Reports" title="Audit reports" description="PDFs are stored in the private reports bucket. Clients can download only reports shared with them." />
      <SectionCard title="All reports">
        <QueryView query={reports} empty={<EmptyState icon={<FileText />} title="No reports yet" description="Open an audit and choose Generate report." />}>
          {(items) => <ReportsTable reports={items} staff tenants={tenants.data} />}
        </QueryView>
      </SectionCard>
    </div>
  );
}
