import { formatMoney, formatNumber } from "@functions/_shared/format.ts";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ClipboardCheck, FileText, Link2, Target, Wallet } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ScoreRing } from "../../components/charts/ScoreRing";
import { TrendChart } from "../../components/charts/TrendChart";
import { ProviderBadge, SeverityBadge, StatusBadge } from "../../components/ui/Badge";
import { Card } from "../../components/ui/Card";
import { LoadingState } from "../../components/ui/LoadingState";
import { EmptyState, PageHeader, SectionCard, StatTile } from "../../components/ui/States";
import { useAuth } from "../../context/AuthProvider";
import { currenciesOf, dailyTotals, formatDate, presetRange, relativeTime, totalsFromCampaigns } from "../../lib/analytics";
import { queryKeys, useApi, useRealtime } from "../../lib/api/ApiProvider";
import { roleAtLeast, useWorkspace } from "./workspace";

export function ClientDashboard() {
  const api = useApi();
  const workspace = useWorkspace();
  const { profile, user } = useAuth();
  useRealtime(["ad_accounts", "audit_runs", "reports"]);
  const name = profile?.full_name?.trim().split(/\s+/)[0] || user?.email?.split("@")[0] || "there";
  const range = useMemo(() => presetRange(30), []);
  const tenantId = workspace.tenant_id;

  const accounts = useQuery({ queryKey: queryKeys.adAccounts(tenantId), queryFn: () => api.listAdAccounts(tenantId) });
  const synced = (accounts.data ?? []).filter((account) => account.sync_enabled);
  const currencies = currenciesOf(synced);
  const singleCurrency = currencies.length <= 1;
  const campaigns = useQuery({
    queryKey: queryKeys.campaigns(tenantId, range.from, range.to),
    queryFn: () => api.getCampaignPerformance(tenantId, range),
    enabled: synced.length > 0 && singleCurrency,
  });
  const daily = useQuery({
    queryKey: queryKeys.daily(tenantId, range.from, range.to),
    queryFn: () => api.getDailyPerformance(tenantId, range),
    enabled: synced.length > 0 && singleCurrency,
  });
  const runs = useQuery({ queryKey: queryKeys.auditRuns(tenantId), queryFn: () => api.listAuditRuns(tenantId) });
  const latest = (runs.data ?? []).find((run) => run.status === "published") ?? null;
  const findings = useQuery({
    queryKey: queryKeys.findings(latest?.id ?? "none"),
    queryFn: () => api.listFindings(latest!.id),
    enabled: Boolean(latest),
  });
  const reports = useQuery({ queryKey: queryKeys.reports(tenantId), queryFn: () => api.listReports(tenantId) });

  const totals = totalsFromCampaigns(campaigns.data ?? []);
  const currency = currencies[0] ?? null;
  const trend = dailyTotals(daily.data ?? [], range).map((day) => ({ date: day.date, value: day.spend }));
  const lastSync = synced.map((account) => account.last_synced_at).filter(Boolean).sort().at(-1) ?? null;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={workspace.business_name}
        title={`Welcome, ${name}`}
        description={synced.length > 0 ? `Advertising performance for the last 30 days · data updated ${relativeTime(lastSync)}` : "Your advertising performance and audit workspace."}
      />

      {accounts.isLoading ? <LoadingState /> : synced.length === 0 ? (
        <Card className="overflow-hidden">
          <EmptyState
            icon={<Link2 />}
            title="Connect your ad accounts to get started"
            description={roleAtLeast(workspace.role, "manager")
              ? "Connect Meta Ads or Google Ads with read-only access. PRISIM syncs campaign data daily and uses it for your audits."
              : "A workspace manager or your PRISIM team will connect your advertising accounts."}
            action={<Link to={`${workspace.base}/accounts`} className="inline-flex items-center gap-1 text-sm font-semibold text-accent-700">Go to ad accounts <ArrowUpRight aria-hidden="true" className="h-4 w-4" /></Link>}
          />
        </Card>
      ) : !singleCurrency ? (
        <Card className="p-5 text-sm text-slate-600">
          Your accounts report in different currencies ({currencies.join(", ")}). See <Link className="font-medium text-accent-700" to={`${workspace.base}/campaigns`}>Campaigns</Link> for per-account performance.
        </Card>
      ) : (
        <section className="grid gap-4 lg:grid-cols-[1fr_1fr_1.6fr]">
          <StatTile label="Spend (30 days)" value={formatMoney(totals.spend, currency, 0)} icon={<Wallet />} detail={`${formatNumber(totals.clicks)} clicks`} />
          <StatTile label="Conversions (30 days)" value={formatNumber(totals.conversions, 0)} icon={<Target />} detail={`Cost per conversion ${formatMoney(totals.cpa, currency)}`} />
          <Card className="px-3 pb-2 pt-4">
            <p className="px-2 text-sm text-slate-500">Daily spend</p>
            {daily.isLoading ? <LoadingState /> : <TrendChart points={trend} label="Spend" height={150} format={(value) => formatMoney(value, currency, 0)} />}
          </Card>
        </section>
      )}

      <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
        <SectionCard
          title="Latest audit"
          actions={latest && <Link to={`${workspace.base}/audits/${latest.id}`} className="inline-flex items-center gap-1 text-sm font-medium text-accent-700">View audit <ArrowUpRight aria-hidden="true" className="h-4 w-4" /></Link>}
        >
          {runs.isLoading ? <LoadingState /> : !latest ? (
            <EmptyState icon={<ClipboardCheck />} title="No audit published yet" description="Your PRISIM team reviews every audit before it appears here." />
          ) : (
            <div className="grid gap-6 p-5 sm:grid-cols-[auto_1fr] sm:p-6">
              <ScoreRing score={latest.overall_score} size={120} />
              <div className="min-w-0">
                <p className="font-semibold text-ink-950">{latest.title}</p>
                <p className="text-xs text-slate-500">{formatDate(latest.period_start)} – {formatDate(latest.period_end)}</p>
                <div className="mt-2 flex gap-3">
                  {(["meta", "google"] as const).filter((platform) => latest.platform_scores?.[platform] !== undefined).map((platform) => (
                    <span key={platform} className="text-xs text-slate-600"><ProviderBadge provider={platform} />: <b>{Math.round(latest.platform_scores[platform] ?? 0)}</b></span>
                  ))}
                </div>
                <ul className="mt-4 space-y-2">
                  {(findings.data ?? []).filter((finding) => finding.severity !== "info").slice(0, 4).map((finding) => (
                    <li key={finding.id} className="flex items-start gap-2 text-sm">
                      <SeverityBadge severity={finding.severity} />
                      <span className="min-w-0 text-slate-700">{finding.title}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Reports"
          actions={<Link to={`${workspace.base}/reports`} className="text-sm font-medium text-accent-700">All reports</Link>}
        >
          {reports.isLoading ? <LoadingState /> : (reports.data ?? []).length === 0 ? (
            <EmptyState icon={<FileText />} title="No reports yet" description="Audit reports shared by PRISIM appear here as PDFs." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {(reports.data ?? []).slice(0, 4).map((report) => (
                <li key={report.id} className="flex items-center gap-3 px-5 py-3">
                  <FileText aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-400" />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-950">{report.report_name}</span>
                  <StatusBadge status={report.status} />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <p className="text-xs text-slate-400">
        You're signed in with <span className="capitalize">{workspace.role}</span> access. Your workspace data is protected by database-level tenant policies.
      </p>
    </div>
  );
}
