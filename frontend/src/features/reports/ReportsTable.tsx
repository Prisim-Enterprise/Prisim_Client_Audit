import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Eye, EyeOff, FileText, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { StatusBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { ConfirmButton } from "../../components/ui/Controls";
import { EmptyState } from "../../components/ui/States";
import { formatBytes, formatDateTime } from "../../lib/analytics";
import { useApi } from "../../lib/api/ApiProvider";
import { errorMessage } from "../../lib/api/errors";
import type { Report, Tenant } from "../../lib/api/types";

export function ReportsTable({
  reports,
  staff = false,
  tenants,
  emptyDescription,
}: {
  reports: Report[];
  staff?: boolean;
  tenants?: Tenant[];
  emptyDescription?: string;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const names = new Map((tenants ?? []).map((tenant) => [tenant.id, tenant.business_name]));
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["reports"] });

  const download = useMutation({
    mutationFn: (report: Report) => api.downloadReport(report),
    onError: (error) => toast.error(errorMessage(error)),
  });
  const visibility = useMutation({
    mutationFn: ({ report, share }: { report: Report; share: boolean }) => api.setReportVisibility(report.id, share ? "client" : "internal"),
    onSuccess: (_data, { share }) => {
      toast.success(share ? "Report shared with the client" : "Report is now internal only");
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (reports.length === 0) {
    return <EmptyState icon={<FileText />} title="No reports yet" description={emptyDescription ?? "Reports appear here once an audit has been published."} />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[680px] text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th scope="col" className="px-5 py-3 font-medium">Report</th>
            {tenants && <th scope="col" className="px-3 py-3 font-medium">Client</th>}
            <th scope="col" className="px-3 py-3 font-medium">Status</th>
            {staff && <th scope="col" className="px-3 py-3 font-medium">Visibility</th>}
            <th scope="col" className="px-3 py-3 font-medium">Generated</th>
            <th scope="col" className="px-5 py-3 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {reports.map((report) => (
            <tr key={report.id} className="hover:bg-slate-50/70">
              <td className="max-w-[320px] px-5 py-3">
                <p className="truncate font-medium text-ink-950">{report.report_name}</p>
                <p className="text-xs text-slate-500">
                  PDF · {formatBytes(report.file_size_bytes)}
                  {staff && report.audit_run_id && (
                    <> · <Link className="text-accent-700 hover:underline" to={`/admin/audits/${report.audit_run_id}`}>audit</Link></>
                  )}
                </p>
                {report.status === "failed" && report.error_message && <p className="text-xs text-rose-600">{report.error_message}</p>}
              </td>
              {tenants && <td className="px-3 py-3 text-slate-600">{names.get(report.tenant_id) ?? "–"}</td>}
              <td className="px-3 py-3"><StatusBadge status={report.status} /></td>
              {staff && <td className="px-3 py-3"><StatusBadge status={report.visibility} /></td>}
              <td className="px-3 py-3 text-slate-600">{formatDateTime(report.generated_at ?? report.created_at)}</td>
              <td className="px-5 py-3">
                <div className="flex justify-end gap-1.5">
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={report.status !== "ready"}
                    loading={download.isPending && download.variables?.id === report.id}
                    onClick={() => download.mutate(report)}
                  >
                    <Download aria-hidden="true" className="h-4 w-4" /> Download
                  </Button>
                  {staff && report.status === "ready" && (
                    <Button
                      size="small"
                      variant="ghost"
                      loading={visibility.isPending && visibility.variables?.report.id === report.id}
                      onClick={() => visibility.mutate({ report, share: report.visibility !== "client" })}
                    >
                      {report.visibility === "client"
                        ? <><EyeOff aria-hidden="true" className="h-4 w-4" /> Unshare</>
                        : <><Eye aria-hidden="true" className="h-4 w-4" /> Share</>}
                    </Button>
                  )}
                  {staff && (
                    <ConfirmButton
                      title="Delete this report?"
                      description="The PDF is removed from storage. The audit itself is not affected and a new report can be generated at any time."
                      confirmLabel="Delete report"
                      variant="ghost"
                      onConfirm={async () => {
                        try {
                          await api.deleteReport(report);
                          toast.success("Report deleted");
                          refresh();
                        } catch (error) {
                          toast.error(errorMessage(error));
                        }
                      }}
                    >
                      <Trash2 aria-hidden="true" className="h-4 w-4" />
                      <span className="sr-only">Delete</span>
                    </ConfirmButton>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
