import { formatMoney, formatMultiple, formatNumber, formatPercent } from "@functions/_shared/format.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ClipboardCheck, Lightbulb, Play } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ScoreBar, ScoreRing } from "../../components/charts/ScoreRing";
import { ProviderBadge, SeverityBadge, StatusBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Select, Textarea } from "../../components/ui/Controls";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/Dialog";
import { Field } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { EmptyState, SectionCard } from "../../components/ui/States";
import { CATEGORY_LABELS, formatDate, presetRange } from "../../lib/analytics";
import { queryKeys, useApi } from "../../lib/api/ApiProvider";
import { errorMessage } from "../../lib/api/errors";
import type { AuditFinding, AuditRun, FindingPatch, FindingStatus, Severity, Tenant } from "../../lib/api/types";

export function AuditOverview({ run }: { run: AuditRun }) {
  const totals = run.kpis.totals ?? null;
  const currency = run.kpis.currency ?? null;
  const categories = Object.entries(run.category_scores ?? {});
  return (
    <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
      <Card className="flex flex-col items-center p-6">
        <p className="self-start text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Account health</p>
        <div className="mt-4"><ScoreRing score={run.overall_score} /></div>
        <div className="mt-5 grid w-full grid-cols-2 gap-3">
          {(["meta", "google"] as const).filter((platform) => run.platform_scores?.[platform] !== undefined).map((platform) => (
            <div key={platform} className="rounded-lg border border-slate-200 p-3 text-center">
              <ProviderBadge provider={platform} />
              <p className="mt-1 text-xl font-semibold text-ink-950">{Math.round(run.platform_scores[platform] ?? 0)}</p>
            </div>
          ))}
        </div>
      </Card>
      <div className="space-y-5">
        {run.summary && (
          <Card className="p-5 sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Executive summary</p>
            <p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-700">{run.summary}</p>
          </Card>
        )}
        {totals && (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi label="Spend" value={formatMoney(totals.spend, currency, 0)} />
            <Kpi label="Conversions" value={formatNumber(totals.conversions, 0)} />
            <Kpi label="Cost / conversion" value={formatMoney(totals.cpa, currency)} />
            <Kpi label={totals.conversionValue > 0 ? "ROAS" : "CTR"} value={totals.conversionValue > 0 ? formatMultiple(totals.roas) : formatPercent(totals.ctr)} />
          </div>
        )}
        {categories.length > 0 && (
          <Card className="grid gap-4 p-5 sm:grid-cols-2 sm:p-6">
            {categories.map(([category, score]) => (
              <ScoreBar key={category} label={CATEGORY_LABELS[category] ?? category} score={Number(score)} />
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold text-ink-950">{value}</p>
    </Card>
  );
}

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

export function FindingCard({
  finding,
  editable = false,
  onChange,
}: {
  finding: AuditFinding;
  editable?: boolean;
  onChange?: (patch: FindingPatch) => Promise<void>;
}) {
  const [note, setNote] = useState(finding.reviewer_note ?? "");
  const [saving, setSaving] = useState(false);
  const apply = async (patch: FindingPatch) => {
    if (!onChange) return;
    setSaving(true);
    try {
      await onChange(patch);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  const dismissed = finding.status === "dismissed";
  return (
    <Card className={dismissed ? "border-dashed bg-slate-50/60 opacity-75" : ""}>
      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={finding.severity} />
          <span className="text-xs text-slate-500">{CATEGORY_LABELS[finding.category] ?? finding.category}</span>
          {finding.platform && <ProviderBadge provider={finding.platform} />}
          {finding.status !== "open" && <StatusBadge status={finding.status} />}
        </div>
        <h3 className="mt-3 font-semibold leading-6 text-ink-950">{finding.title}</h3>
        <p className="mt-1.5 text-sm leading-6 text-slate-600">{finding.description}</p>
        <div className="mt-4 rounded-lg bg-accent-50/70 p-4">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-accent-700">
            <Lightbulb aria-hidden="true" className="h-3.5 w-3.5" /> Recommendation
          </p>
          <p className="mt-1.5 text-sm leading-6 text-ink-900">{finding.recommendation}</p>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
          {finding.estimated_impact !== null && finding.impact_currency && (
            <span className="font-medium text-orange-700">Spend at risk: {formatMoney(finding.estimated_impact, finding.impact_currency, 0)}</span>
          )}
          {Object.entries(finding.evidence ?? {}).slice(0, 4).map(([key, value]) => (
            <span key={key}>{key.replace(/_/g, " ")}: <span className="text-slate-700">{String(value)}</span></span>
          ))}
        </div>
        {!editable && finding.reviewer_note && (
          <p className="mt-3 border-l-2 border-accent-500 pl-3 text-sm text-slate-700">
            <span className="font-medium">PRISIM note:</span> {finding.reviewer_note}
          </p>
        )}
      </div>
      {editable && (
        <div className="space-y-3 border-t border-slate-100 bg-slate-50/60 p-4 sm:px-6">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-36">
              <label htmlFor={`severity-${finding.id}`} className="mb-1 block text-xs font-medium text-slate-600">Severity</label>
              <Select id={`severity-${finding.id}`} value={finding.severity} disabled={saving} onChange={(event) => void apply({ severity: event.target.value as Severity })}>
                {SEVERITIES.map((severity) => <option key={severity} value={severity}>{severity}</option>)}
              </Select>
            </div>
            <div className="w-40">
              <label htmlFor={`status-${finding.id}`} className="mb-1 block text-xs font-medium text-slate-600">Review status</label>
              <Select id={`status-${finding.id}`} value={finding.status} disabled={saving} onChange={(event) => void apply({ status: event.target.value as FindingStatus })}>
                <option value="open">Open</option>
                <option value="accepted">Accepted</option>
                <option value="resolved">Resolved</option>
                <option value="dismissed">Dismissed (hidden from client)</option>
              </Select>
            </div>
          </div>
          <div>
            <label htmlFor={`note-${finding.id}`} className="mb-1 block text-xs font-medium text-slate-600">Reviewer note (visible to the client after publication)</label>
            <Textarea id={`note-${finding.id}`} className="min-h-16" maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} />
            <div className="mt-2 flex justify-end">
              <Button size="small" variant="secondary" loading={saving} disabled={note === (finding.reviewer_note ?? "")} onClick={() => void apply({ reviewer_note: note.trim() || null })}>
                Save note
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

export function FindingsList({
  findings,
  editable,
  onChange,
  emptyText = "No issues were identified for this period.",
}: {
  findings: AuditFinding[];
  editable?: boolean;
  onChange?: (findingId: string, patch: FindingPatch) => Promise<void>;
  emptyText?: string;
}) {
  const [severity, setSeverity] = useState<"all" | Severity>("all");
  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const finding of findings) result[finding.severity] = (result[finding.severity] ?? 0) + 1;
    return result;
  }, [findings]);
  const visible = findings.filter((finding) => severity === "all" || finding.severity === severity);
  if (findings.length === 0) {
    return <Card><EmptyState icon={<ClipboardCheck />} title="No findings" description={emptyText} /></Card>;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter findings by severity">
        {(["all", ...SEVERITIES] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={severity === value}
            onClick={() => setSeverity(value)}
            className={`rounded-full border px-3 py-1 text-xs font-medium capitalize transition ${severity === value ? "border-ink-950 bg-ink-950 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}
          >
            {value} {value === "all" ? findings.length : counts[value] ?? 0}
          </button>
        ))}
      </div>
      {visible.map((finding) => (
        <FindingCard key={finding.id} finding={finding} editable={editable} onChange={onChange ? (patch) => onChange(finding.id, patch) : undefined} />
      ))}
    </div>
  );
}

export function AuditRunTable({
  runs,
  tenants,
  linkTo,
}: {
  runs: AuditRun[];
  tenants?: Tenant[];
  linkTo: (run: AuditRun) => string;
}) {
  const names = new Map((tenants ?? []).map((tenant) => [tenant.id, tenant.business_name]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th scope="col" className="px-5 py-3 font-medium">Audit</th>
            {tenants && <th scope="col" className="px-3 py-3 font-medium">Client</th>}
            <th scope="col" className="px-3 py-3 font-medium">Period</th>
            <th scope="col" className="px-3 py-3 text-right font-medium">Score</th>
            <th scope="col" className="px-3 py-3 font-medium">Status</th>
            <th scope="col" className="px-5 py-3 font-medium"><span className="sr-only">Open</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {runs.map((run) => (
            <tr key={run.id} className="hover:bg-slate-50/70">
              <td className="px-5 py-3">
                <Link to={linkTo(run)} className="font-medium text-ink-950 hover:text-accent-700">{run.title}</Link>
                <p className="text-xs text-slate-500">Created {formatDate(run.created_at)}</p>
              </td>
              {tenants && <td className="px-3 py-3 text-slate-600">{names.get(run.tenant_id) ?? "–"}</td>}
              <td className="px-3 py-3 text-slate-600">{formatDate(run.period_start)} – {formatDate(run.period_end)}</td>
              <td className="px-3 py-3 text-right font-semibold tabular-nums text-ink-950">{run.overall_score === null ? "–" : Math.round(run.overall_score)}</td>
              <td className="px-3 py-3"><StatusBadge status={run.status} /></td>
              <td className="px-5 py-3 text-right">
                <Link to={linkTo(run)} className="inline-flex items-center gap-1 text-sm font-medium text-accent-700 hover:text-accent-800">
                  Open <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RunAuditButton({ tenantId, children }: { tenantId?: string; children?: ReactNode }) {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selectedTenant, setSelectedTenant] = useState(tenantId ?? "");
  const [days, setDays] = useState("30");
  const [title, setTitle] = useState("");
  const [accountIds, setAccountIds] = useState<string[] | null>(null);

  const tenantsQuery = useQuery({ queryKey: queryKeys.tenants, queryFn: () => api.listTenants(), enabled: open && !tenantId });
  const accountsQuery = useQuery({
    queryKey: queryKeys.adAccounts(selectedTenant),
    queryFn: () => api.listAdAccounts(selectedTenant),
    enabled: open && Boolean(selectedTenant),
  });
  const accounts = accountsQuery.data ?? [];
  const chosen = accountIds ?? accounts.filter((account) => account.sync_enabled).map((account) => account.id);

  const run = useMutation({
    mutationFn: () => {
      const range = presetRange(Number(days));
      return api.runAudit({
        tenantId: selectedTenant,
        periodStart: range.from,
        periodEnd: range.to,
        adAccountIds: chosen,
        title: title.trim() || undefined,
      });
    },
    onSuccess: ({ auditRunId }) => {
      toast.success("Audit complete. Review the findings before publishing.");
      void queryClient.invalidateQueries({ queryKey: ["audit-runs"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      setOpen(false);
      navigate(`/admin/audits/${auditRunId}`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Play aria-hidden="true" className="h-4 w-4" /> {children ?? "Run audit"}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !run.isPending && setOpen(next)}>
        <DialogContent className="max-w-xl">
          <DialogTitle>Run an advertising audit</DialogTitle>
          <DialogDescription>
            The audit engine analyses synced campaign data and creates a draft for PRISIM review. Clients see it only after you publish.
          </DialogDescription>
          <form
            className="mt-5 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              run.mutate();
            }}
          >
            {!tenantId && (
              <Field label="Client" htmlFor="audit-tenant">
                <Select id="audit-tenant" required value={selectedTenant} onChange={(event) => {
                  setSelectedTenant(event.target.value);
                  setAccountIds(null);
                }}>
                  <option value="">Choose a client…</option>
                  {(tenantsQuery.data ?? []).filter((tenant) => tenant.status === "active").map((tenant) => (
                    <option key={tenant.id} value={tenant.id}>{tenant.business_name}</option>
                  ))}
                </Select>
              </Field>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Audit period" htmlFor="audit-days">
                <Select id="audit-days" value={days} onChange={(event) => setDays(event.target.value)}>
                  <option value="14">Last 14 days</option>
                  <option value="30">Last 30 days</option>
                  <option value="60">Last 60 days</option>
                  <option value="90">Last 90 days</option>
                </Select>
              </Field>
              <Field label="Title (optional)" htmlFor="audit-title">
                <Input id="audit-title" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Q4 performance audit" />
              </Field>
            </div>
            {selectedTenant && (
              <fieldset>
                <legend className="text-sm font-medium text-slate-700">Ad accounts</legend>
                {accountsQuery.isLoading ? (
                  <p className="mt-2 text-sm text-slate-500">Loading accounts…</p>
                ) : accounts.length === 0 ? (
                  <p className="mt-2 text-sm text-slate-500">This client has no ad accounts yet.</p>
                ) : (
                  <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
                    {accounts.map((account) => (
                      <li key={account.id}>
                        <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-slate-50">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-slate-300 text-accent-600"
                            checked={chosen.includes(account.id)}
                            onChange={(event) =>
                              setAccountIds(event.target.checked ? [...chosen, account.id] : chosen.filter((value) => value !== account.id))}
                          />
                          <span className="min-w-0 flex-1 truncate">{account.account_name ?? account.external_account_id}</span>
                          <ProviderBadge provider={account.provider} />
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </fieldset>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={run.isPending}>Cancel</Button>
              <Button type="submit" loading={run.isPending} disabled={!selectedTenant || chosen.length === 0}>Run audit</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AuditSection({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return <SectionCard title={title} actions={actions}>{children}</SectionCard>;
}
