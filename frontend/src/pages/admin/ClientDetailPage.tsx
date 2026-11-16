import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Circle, ClipboardCheck } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Alert } from "../../components/ui/Alert";
import { StatusBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { ConfirmButton, Tabs } from "../../components/ui/Controls";
import { Field } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { LoadingState } from "../../components/ui/LoadingState";
import { EmptyState, ErrorState, PageHeader, QueryView, SectionCard } from "../../components/ui/States";
import { PerformancePanel } from "../../features/analytics/PerformancePanel";
import { AuditRunTable, RunAuditButton } from "../../features/audits/AuditComponents";
import { ConnectionsPanel } from "../../features/connections/ConnectionsPanel";
import { ReportsTable } from "../../features/reports/ReportsTable";
import { ClientUsersPanel } from "../../features/team/TeamPanel";
import { queryKeys, useApi, useRealtime } from "../../lib/api/ApiProvider";
import { errorMessage } from "../../lib/api/errors";
import type { AdAccount, Tenant, TenantInput, TenantStatus } from "../../lib/api/types";
import { ActivityList } from "./ActivityPage";
import { tenantSchema } from "./ClientsPage";

type Tab = "overview" | "users" | "connections" | "audits" | "reports" | "activity";
const TABS: Array<{ value: Tab; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "users", label: "Users" },
  { value: "connections", label: "Connections" },
  { value: "audits", label: "Audits" },
  { value: "reports", label: "Reports" },
  { value: "activity", label: "Activity" },
];

export function ClientDetailPage() {
  const api = useApi();
  const { tenantId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((item) => item.value === params.get("tab")) ? params.get("tab") : "overview") as Tab;
  const tenantQuery = useQuery({ queryKey: queryKeys.tenant(tenantId), queryFn: () => api.getTenant(tenantId) });

  if (tenantQuery.isLoading) return <LoadingState />;
  if (tenantQuery.error) return <ErrorState error={tenantQuery.error} onRetry={() => void tenantQuery.refetch()} />;
  const tenant = tenantQuery.data;
  if (!tenant) return <EmptyState title="Client not found" action={<Link className="text-sm font-medium text-accent-700" to="/admin/clients">Back to clients</Link>} />;

  return (
    <div className="space-y-6">
      <Link to="/admin/clients" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-ink-950">
        <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Clients
      </Link>
      <PageHeader
        eyebrow={tenant.industry ?? "Client"}
        title={tenant.business_name}
        description={<span className="inline-flex flex-wrap items-center gap-2"><StatusBadge status={tenant.status} /> <span>/app/{tenant.slug}</span></span>}
        actions={tenant.status === "active" ? <RunAuditButton tenantId={tenant.id} /> : undefined}
      />
      <Tabs label="Client sections" value={tab} onChange={(value) => setParams({ tab: value }, { replace: true })} items={TABS} />
      {tab === "overview" && <OverviewTab tenant={tenant} openTab={(value) => setParams({ tab: value }, { replace: true })} />}
      {tab === "users" && <ClientUsersPanel tenantId={tenant.id} tenantActive={tenant.status === "active"} />}
      {tab === "connections" && <ConnectionsPanel tenantId={tenant.id} canManage />}
      {tab === "audits" && <AuditsTab tenantId={tenant.id} />}
      {tab === "reports" && <ReportsTab tenantId={tenant.id} />}
      {tab === "activity" && <SectionCard title="Activity"><ActivityList tenantId={tenant.id} /></SectionCard>}
    </div>
  );
}

function OverviewTab({ tenant, openTab }: { tenant: Tenant; openTab: (tab: Tab) => void }) {
  const api = useApi();
  const accounts = useQuery({ queryKey: queryKeys.adAccounts(tenant.id), queryFn: () => api.listAdAccounts(tenant.id) });
  return (
    <div className="space-y-6">
      <OnboardingChecklist tenant={tenant} accounts={accounts.data} openTab={openTab} />
      <ProfileForm tenant={tenant} />
      <div>
        <h2 className="mb-3 text-lg font-semibold text-ink-950">Performance</h2>
        {accounts.isLoading ? <LoadingState /> : accounts.error ? <ErrorState error={accounts.error} /> : (
          <PerformancePanel tenantId={tenant.id} accounts={(accounts.data ?? []).filter((account) => account.sync_enabled)} />
        )}
      </div>
    </div>
  );
}

function ProfileForm({ tenant }: { tenant: Tenant }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const form = useForm<import("zod").input<typeof tenantSchema>, unknown, TenantInput>({ resolver: zodResolver(tenantSchema) });
  useEffect(() => {
    form.reset({
      business_name: tenant.business_name,
      slug: tenant.slug,
      email: tenant.email ?? "",
      industry: tenant.industry ?? "",
      website: tenant.website ?? "",
      primary_contact_name: tenant.primary_contact_name ?? "",
    });
  }, [tenant, form]);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.tenants });
    void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
  };
  const save = useMutation({
    mutationFn: (values: TenantInput) => api.updateTenant(tenant.id, values),
    onSuccess: () => {
      toast.success("Client details saved");
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const setStatus = async (status: TenantStatus) => {
    try {
      await api.updateTenant(tenant.id, { status });
      toast.success(status === "active" ? "Client reactivated" : "Client access suspended");
      refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };
  const errors = form.formState.errors;
  return (
    <SectionCard
      title="Client details"
      actions={tenant.status === "active" ? (
        <ConfirmButton
          title="Suspend client access?"
          description="Client users immediately lose access to this workspace. Data, connections and audits are kept, and you can reactivate at any time."
          confirmLabel="Suspend access"
          onConfirm={() => setStatus("suspended")}
        >
          Suspend access
        </ConfirmButton>
      ) : (
        <Button size="small" variant="secondary" onClick={() => void setStatus("active")}>Reactivate</Button>
      )}
    >
      {tenant.status !== "active" && (
        <div className="px-5 pt-4 sm:px-6"><Alert tone="error">This client is {tenant.status}. Its users cannot sign in to the workspace.</Alert></div>
      )}
      <form className="grid gap-4 p-5 sm:grid-cols-2 sm:p-6" noValidate onSubmit={form.handleSubmit((values) => save.mutate(values))}>
        <Field label="Business name" htmlFor="edit-name" error={errors.business_name?.message}><Input id="edit-name" {...form.register("business_name")} /></Field>
        <Field label="Workspace slug" htmlFor="edit-slug" error={errors.slug?.message} hint="Changing the slug changes client portal links."><Input id="edit-slug" {...form.register("slug")} /></Field>
        <Field label="Industry" htmlFor="edit-industry" error={errors.industry?.message}><Input id="edit-industry" {...form.register("industry")} /></Field>
        <Field label="Primary contact" htmlFor="edit-contact" error={errors.primary_contact_name?.message}><Input id="edit-contact" {...form.register("primary_contact_name")} /></Field>
        <Field label="Contact email" htmlFor="edit-email" error={errors.email?.message}><Input id="edit-email" type="email" {...form.register("email")} /></Field>
        <Field label="Website" htmlFor="edit-website" error={errors.website?.message}><Input id="edit-website" {...form.register("website")} /></Field>
        <div className="flex justify-end sm:col-span-2">
          <Button type="submit" loading={save.isPending} disabled={!form.formState.isDirty}>Save changes</Button>
        </div>
      </form>
    </SectionCard>
  );
}

function AuditsTab({ tenantId }: { tenantId: string }) {
  const api = useApi();
  useRealtime(["audit_runs"]);
  const runs = useQuery({ queryKey: queryKeys.auditRuns(tenantId), queryFn: () => api.listAuditRuns(tenantId) });
  return (
    <SectionCard title="Audits" actions={<RunAuditButton tenantId={tenantId} />}>
      <QueryView query={runs} empty={<EmptyState icon={<ClipboardCheck />} title="No audits yet" description="Connect and sync an ad account, then run the first audit." />}>
        {(items) => <AuditRunTable runs={items} linkTo={(run) => `/admin/audits/${run.id}`} />}
      </QueryView>
    </SectionCard>
  );
}

function ReportsTab({ tenantId }: { tenantId: string }) {
  const api = useApi();
  useRealtime(["reports"]);
  const reports = useQuery({ queryKey: queryKeys.reports(tenantId), queryFn: () => api.listReports(tenantId) });
  return (
    <SectionCard title="Reports" description="Generate reports from an audit's review page.">
      <QueryView query={reports}>{(items) => <ReportsTable reports={items} staff />}</QueryView>
    </SectionCard>
  );
}


/**
 * Onboarding status derived from the client's existing records (no separate
 * status field): each step links to the tab where staff complete it.
 */
function OnboardingChecklist({ tenant, accounts, openTab }: { tenant: Tenant; accounts: AdAccount[] | undefined; openTab: (tab: Tab) => void }) {
  const api = useApi();
  const members = useQuery({ queryKey: queryKeys.members(tenant.id), queryFn: () => api.listMembers(tenant.id) });
  const runs = useQuery({ queryKey: queryKeys.auditRuns(tenant.id), queryFn: () => api.listAuditRuns(tenant.id) });
  const reports = useQuery({ queryKey: queryKeys.reports(tenant.id), queryFn: () => api.listReports(tenant.id) });
  if (!accounts || members.isLoading || runs.isLoading || reports.isLoading) return null;

  const steps: Array<{ label: string; done: boolean; tab: Tab }> = [
    { label: "Business and contact details", done: Boolean(tenant.email && tenant.primary_contact_name), tab: "overview" },
    { label: "Client owner account created", done: (members.data ?? []).some((member) => member.role === "owner" && member.status === "active"), tab: "users" },
    { label: "Ad account connected", done: accounts.length > 0, tab: "connections" },
    { label: "Campaign data synced", done: accounts.some((account) => account.last_synced_at), tab: "connections" },
    { label: "First audit published", done: (runs.data ?? []).some((run) => run.status === "published"), tab: "audits" },
    { label: "Report shared with the client", done: (reports.data ?? []).some((report) => report.visibility === "client" && report.status === "ready"), tab: "reports" },
  ];
  const complete = steps.filter((step) => step.done).length;
  return (
    <SectionCard title="Onboarding" description={complete === steps.length ? "Onboarding complete." : `${complete} of ${steps.length} steps complete.`}>
      <ol className="grid gap-2 p-5 sm:grid-cols-2 sm:p-6 xl:grid-cols-3">
        {steps.map((step) => (
          <li key={step.label}>
            <button
              type="button"
              onClick={() => openTab(step.tab)}
              className="flex w-full items-center gap-2.5 rounded-lg border border-slate-200 px-3 py-2.5 text-left text-sm transition hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            >
              {step.done
                ? <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0 text-emerald-600" />
                : <Circle aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-300" />}
              <span className={step.done ? "text-slate-500" : "font-medium text-ink-950"}>{step.label}</span>
              <span className="sr-only">{step.done ? "(done)" : "(to do)"}</span>
            </button>
          </li>
        ))}
      </ol>
    </SectionCard>
  );
}
