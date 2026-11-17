import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowLeft, FilePlus2, Send, ShieldCheck, Trash2, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Alert } from "../../components/ui/Alert";
import { StatusBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { ConfirmButton, Textarea } from "../../components/ui/Controls";
import { LoadingState } from "../../components/ui/LoadingState";
import { EmptyState, ErrorState, PageHeader, QueryView, SectionCard } from "../../components/ui/States";
import { AuditOverview, FindingsList } from "../../features/audits/AuditComponents";
import { ReportsTable } from "../../features/reports/ReportsTable";
import { formatDate, formatDateTime } from "../../lib/analytics";
import { queryKeys, useApi, useRealtime } from "../../lib/api/ApiProvider";
import { errorMessage } from "../../lib/api/errors";
import type { AuditRun, AuditStatus } from "../../lib/api/types";

export function AuditReviewPage() {
  const api = useApi();
  const { auditId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useRealtime(["audit_runs", "reports"]);
  const runQuery = useQuery({ queryKey: queryKeys.auditRun(auditId), queryFn: () => api.getAuditRun(auditId) });
  const findings = useQuery({ queryKey: queryKeys.findings(auditId), queryFn: () => api.listFindings(auditId) });
  const run = runQuery.data ?? null;
  const tenant = useQuery({ queryKey: queryKeys.tenant(run?.tenant_id ?? ""), queryFn: () => api.getTenant(run!.tenant_id), enabled: Boolean(run) });
  const reports = useQuery({
    queryKey: queryKeys.reports(run?.tenant_id),
    queryFn: () => api.listReports(run!.tenant_id),
    enabled: Boolean(run),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.auditRun(auditId) });
    void queryClient.invalidateQueries({ queryKey: ["audit-runs"] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
  };

  const status = useMutation({
    mutationFn: ({ next, summary }: { next: AuditStatus; summary?: string }) => api.setAuditStatus(auditId, next, summary),
    onSuccess: (_data, { next }) => {
      toast.success(next === "published" ? "Audit published to the client" : next === "archived" ? "Audit archived" : next === "in_review" ? "Submitted for review" : "Moved back to draft");
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const report = useMutation({
    mutationFn: (share: boolean) => api.generateReport(auditId, share),
    onSuccess: () => {
      toast.success("Report generated");
      void queryClient.invalidateQueries({ queryKey: ["reports"] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (runQuery.isLoading) return <LoadingState label="Loading audit…" />;
  if (runQuery.error) return <ErrorState error={runQuery.error} onRetry={() => void runQuery.refetch()} />;
  if (!run) return <EmptyState title="Audit not found" action={<Link to="/admin/audits" className="text-sm font-medium text-accent-700">Back to audits</Link>} />;

  const editable = run.status === "draft" || run.status === "in_review";
  const runReports = (reports.data ?? []).filter((item) => item.audit_run_id === run.id);
  const visibleFindings = (findings.data ?? []).filter((finding) => finding.status !== "dismissed").length;

  return (
    <div className="space-y-6">
      <Link to="/admin/audits" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-ink-950">
        <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Audits
      </Link>
      <PageHeader
        eyebrow={tenant.data?.business_name ?? "Audit"}
        title={run.title}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <StatusBadge status={run.status} />
            <span>{formatDate(run.period_start)} – {formatDate(run.period_end)}</span>
            <span className="text-slate-400">·</span>
            <span>engine {run.engine_version}</span>
            {run.published_at && <><span className="text-slate-400">·</span><span>published {formatDateTime(run.published_at)}</span></>}
          </span>
        }
        actions={
          <>
            {run.status === "draft" && (
              <Button variant="secondary" loading={status.isPending} onClick={() => status.mutate({ next: "in_review" })}>
                <Send aria-hidden="true" className="h-4 w-4" /> Submit for review
              </Button>
            )}
            {run.status === "in_review" && (
              <Button variant="ghost" loading={status.isPending} onClick={() => status.mutate({ next: "draft" })}>
                <Undo2 aria-hidden="true" className="h-4 w-4" /> Back to draft
              </Button>
            )}
            {editable && (
              <ConfirmButton
                title="Publish this audit?"
                description={`The client will see the score, summary and ${visibleFindings} finding${visibleFindings === 1 ? "" : "s"} (dismissed findings stay hidden). Published audits can't be edited; archive and re-run instead.`}
                confirmLabel="Publish to client"
                confirmVariant="primary"
                variant="primary"
                size="default"
                onConfirm={() => status.mutateAsync({ next: "published" }).catch(() => undefined)}
              >
                <ShieldCheck aria-hidden="true" className="h-4 w-4" /> Publish
              </ConfirmButton>
            )}
            {run.status === "published" && (
              <ConfirmButton
                title="Archive this audit?"
                description="The client no longer sees it. Reports already shared stay shared until you unshare them."
                confirmLabel="Archive"
                onConfirm={() => status.mutateAsync({ next: "archived" }).catch(() => undefined)}
                size="default"
              >
                <Archive aria-hidden="true" className="h-4 w-4" /> Archive
              </ConfirmButton>
            )}
            {editable && (
              <ConfirmButton
                title="Delete this draft?"
                description="The draft and its findings are permanently deleted."
                confirmLabel="Delete draft"
                variant="ghost"
                size="default"
                onConfirm={async () => {
                  try {
                    await api.deleteAuditRun(run.id);
                    toast.success("Draft deleted");
                    refresh();
                    navigate("/admin/audits");
                  } catch (error) {
                    toast.error(errorMessage(error));
                  }
                }}
              >
                <Trash2 aria-hidden="true" className="h-4 w-4" /><span className="sr-only">Delete draft</span>
              </ConfirmButton>
            )}
          </>
        }
      />

      {editable ? (
        <Alert tone="info" title="Not visible to the client">
          Review each finding: adjust severity, dismiss false positives and add notes. Publishing makes the audit read-only and visible to the client.
        </Alert>
      ) : run.status === "published" ? (
        <Alert tone="success" title="Published">This audit is visible to the client's users and can no longer be edited.</Alert>
      ) : null}

      <AuditOverview run={run} />

      {editable && (
        <SummaryEditor
          run={run}
          onSave={async (summary) => {
            try {
              await api.updateAuditSummary(run.id, summary);
              toast.success("Summary saved");
              refresh();
            } catch (error) {
              toast.error(errorMessage(error));
            }
          }}
        />
      )}

      <SectionCard
        title="Reports"
        description="PDF reports for this audit. Draft PDFs are marked as drafts and stay internal."
        actions={
          <>
            <Button size="small" variant="secondary" loading={report.isPending && report.variables === false} onClick={() => report.mutate(false)}>
              <FilePlus2 aria-hidden="true" className="h-4 w-4" /> Generate internal PDF
            </Button>
            {run.status === "published" && (
              <Button size="small" loading={report.isPending && report.variables === true} onClick={() => report.mutate(true)}>
                <FilePlus2 aria-hidden="true" className="h-4 w-4" /> Generate & share with client
              </Button>
            )}
          </>
        }
      >
        {reports.isLoading ? <LoadingState /> : <ReportsTable reports={runReports} staff emptyDescription="No PDF has been generated for this audit yet." />}
      </SectionCard>

      <div>
        <h2 className="mb-3 text-lg font-semibold text-ink-950">Findings</h2>
        <QueryView query={findings}>
          {(items) => (
            <FindingsList
              findings={items}
              editable={editable}
              onChange={async (findingId, patch) => {
                await api.updateFinding(findingId, patch);
                await queryClient.invalidateQueries({ queryKey: queryKeys.findings(auditId) });
              }}
            />
          )}
        </QueryView>
      </div>
    </div>
  );
}

function SummaryEditor({ run, onSave }: { run: AuditRun; onSave: (summary: string) => Promise<unknown> }) {
  const [summary, setSummary] = useState(run.summary ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => setSummary(run.summary ?? ""), [run.summary]);
  return (
    <SectionCard title="Executive summary" description="Generated by the engine; edit it in your own words before publishing.">
      <div className="space-y-3 p-5 sm:p-6">
        <label htmlFor="audit-summary" className="sr-only">Executive summary</label>
        <Textarea id="audit-summary" className="min-h-32" maxLength={5000} value={summary} onChange={(event) => setSummary(event.target.value)} />
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-400">{summary.length} / 5000</span>
          <Button
            size="small"
            variant="secondary"
            loading={saving}
            disabled={summary === (run.summary ?? "")}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave(summary);
              } finally {
                setSaving(false);
              }
            }}
          >
            Save summary
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}
