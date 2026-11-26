import {
  availableDailyMetrics,
  campaignView,
  DAILY_METRIC_LABEL,
  type DailyMetric,
  dailySeries,
  summarizePlatforms,
} from "@functions/_shared/analytics/platform.ts";
import { addDays, formatMoney, formatMultiple, formatNumber, formatPercent, ratio } from "@functions/_shared/format.ts";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { useMemo, useState } from "react";
import { BarList, TrendChart } from "../../components/charts/TrendChart";
import { ProviderBadge, StatusBadge } from "../../components/ui/Badge";
import { Card } from "../../components/ui/Card";
import { Select, Tabs } from "../../components/ui/Controls";
import { LoadingState } from "../../components/ui/LoadingState";
import { EmptyState, ErrorState, SectionCard } from "../../components/ui/States";
import { currenciesOf, presetRange, RANGE_PRESETS, type RangePreset } from "../../lib/analytics";
import { queryKeys, useApi } from "../../lib/api/ApiProvider";
import type { AdAccount, CampaignPerformance } from "../../lib/api/types";
import { PlatformSummaries } from "./PlatformSummaries";

type SortKey = "spend" | "results" | "cost_per_result" | "ctr" | "roas";

export function PerformancePanel({ tenantId, accounts, compact = false }: { tenantId: string; accounts: AdAccount[]; compact?: boolean }) {
  const api = useApi();
  const [preset, setPreset] = useState<RangePreset>("30");
  const currencies = currenciesOf(accounts);
  const mixedCurrency = currencies.length > 1;
  const [accountId, setAccountId] = useState<string>(mixedCurrency ? accounts[0]?.id ?? "" : "");
  const [metric, setMetric] = useState<DailyMetric>("spend");
  const [sort, setSort] = useState<SortKey>("spend");
  const range = useMemo(() => presetRange(Number(preset)), [preset]);
  const selectedAccount = accounts.find((account) => account.id === accountId);
  const currency = selectedAccount?.currency ?? (mixedCurrency ? null : currencies[0] ?? null);

  const campaignsQuery = useQuery({
    queryKey: queryKeys.campaigns(tenantId, range.from, range.to, accountId || undefined),
    queryFn: () => api.getCampaignPerformance(tenantId, range, accountId || undefined),
  });
  const dailyQuery = useQuery({
    queryKey: queryKeys.daily(tenantId, range.from, range.to, accountId || undefined),
    queryFn: () => api.getDailyPerformance(tenantId, range, accountId || undefined),
  });

  const campaigns = campaignsQuery.data ?? [];
  // Platform summaries: Google and Meta are never combined (shared with the PDF report).
  const summaries = summarizePlatforms(campaigns);
  const totalSpend = campaigns.reduce((sum, campaign) => sum + campaign.spend, 0);
  const totalImpressions = campaigns.reduce((sum, campaign) => sum + campaign.impressions, 0);
  const money = (value: number | null) => formatMoney(value, currency, 0);

  const metrics = availableDailyMetrics(campaigns);
  const activeMetric = metrics.includes(metric) ? metric : "spend";
  const dates: string[] = [];
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) dates.push(day);
  const points = dailySeries(dailyQuery.data ?? [], dates, activeMetric);
  const moneyMetric = activeMetric === "spend" || activeMetric === "google_cost_per_conversion";

  const sorted = [...campaigns]
    .filter((campaign) => campaign.spend > 0 || campaign.impressions > 0)
    .sort((a, b) => compareCampaigns(a, b, sort));

  const filters = (
    <div className="flex flex-wrap gap-2">
      <div className="w-44">
        <label className="sr-only" htmlFor={`range-${tenantId}`}>Date range</label>
        <Select id={`range-${tenantId}`} value={preset} onChange={(event) => setPreset(event.target.value as RangePreset)}>
          {RANGE_PRESETS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </Select>
      </div>
      {accounts.length > 1 && (
        <div className="w-64">
          <label className="sr-only" htmlFor={`account-${tenantId}`}>Ad account</label>
          <Select id={`account-${tenantId}`} value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            {!mixedCurrency && <option value="">All ad accounts</option>}
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.account_name ?? account.external_account_id} ({account.provider === "meta" ? "Meta" : "Google"})
              </option>
            ))}
          </Select>
        </div>
      )}
    </div>
  );

  if (accounts.length === 0) {
    return (
      <Card>
        <EmptyState icon={<BarChart3 />} title="No ad accounts yet" description="Connect a Meta or Google Ads account and run a sync to see campaign performance." />
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {filters}
        <p className="text-xs text-slate-500">
          {range.from} to {range.to} · complete days only
          {mixedCurrency && " · accounts use different currencies, so one account is shown at a time"}
        </p>
      </div>

      {campaignsQuery.error ? (
        <Card><ErrorState error={campaignsQuery.error} onRetry={() => void campaignsQuery.refetch()} /></Card>
      ) : campaignsQuery.isLoading ? (
        <Card><LoadingState label="Loading performance…" /></Card>
      ) : campaigns.length === 0 || totalImpressions === 0 ? (
        <Card>
          <EmptyState icon={<BarChart3 />} title="No performance data for this period" description="Data appears after the first successful sync of a selected ad account." />
        </Card>
      ) : (
        <>
          <PlatformSummaries summaries={summaries} />

          <div className={compact ? "space-y-5" : "grid gap-5 xl:grid-cols-[1.6fr_1fr]"}>
            <SectionCard
              title="Daily trend"
              actions={
                <div className="w-full sm:w-auto">
                  <Tabs
                    label="Trend metric"
                    value={activeMetric}
                    onChange={setMetric}
                    items={metrics.map((value) => ({ value, label: DAILY_METRIC_LABEL[value] }))}
                  />
                </div>
              }
              bodyClassName="px-3 py-4 sm:px-5"
            >
              {dailyQuery.isLoading ? <LoadingState /> : dailyQuery.error ? <ErrorState error={dailyQuery.error} /> : (
                <>
                  <TrendChart
                    points={points}
                    label={DAILY_METRIC_LABEL[activeMetric]}
                    format={(value) => (moneyMetric ? formatMoney(value, currency, 0) : formatNumber(value, 0))}
                  />
                  {activeMetric.startsWith("meta_") && points.some((point) => point.value === null) && (
                    <p className="mt-2 text-xs text-slate-500">Gaps: days whose Meta data was synced before link clicks and results were stored.</p>
                  )}
                </>
              )}
            </SectionCard>
            <SectionCard title="Spend by campaign" description="Top campaigns in the period" bodyClassName="p-5 sm:p-6">
              <BarList
                format={(value) => money(value)}
                items={sorted.slice(0, 6).map((campaign) => ({
                  key: campaign.campaign_id,
                  label: campaign.campaign_name ?? campaign.external_campaign_id,
                  value: campaign.spend,
                  detail: `${resultText(campaign)} · ${formatPercent(ratio(campaign.spend, totalSpend), 0)} of spend`,
                }))}
              />
            </SectionCard>
          </div>

          <SectionCard
            title="Campaigns"
            description={`${sorted.length} campaign${sorted.length === 1 ? "" : "s"} with delivery`}
            actions={
              <div className="w-48">
                <label className="sr-only" htmlFor={`sort-${tenantId}`}>Sort campaigns</label>
                <Select id={`sort-${tenantId}`} value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
                  <option value="spend">Sort by spend</option>
                  <option value="results">Sort by results</option>
                  <option value="cost_per_result">Sort by cost / result</option>
                  <option value="ctr">Sort by CTR (link CTR for Meta)</option>
                  <option value="roas">Sort by ROAS</option>
                </Select>
              </div>
            }
          >
            <CampaignTable campaigns={sorted} />
          </SectionCard>
        </>
      )}
    </div>
  );
}

const UNAVAILABLE = "Unavailable";

/** "12 leads", "40 conversions", "No result metric" or "Unavailable" for one campaign. */
export function resultText(campaign: CampaignPerformance) {
  const view = campaignView(campaign);
  if (!view.result) return "No result metric (awareness/engagement)";
  if (view.result.count === null) return `${view.result.label}: ${UNAVAILABLE}`;
  return `${formatNumber(view.result.count, 0)} ${view.result.label.toLowerCase()}`;
}

function sortValue(campaign: CampaignPerformance, key: SortKey): number | null {
  const view = campaignView(campaign);
  switch (key) {
    case "spend":
      return campaign.spend;
    case "results":
      return view.result?.count ?? null;
    case "cost_per_result":
      return view.result?.cost ?? null;
    case "ctr":
      return view.ctr;
    case "roas":
      return view.roas;
  }
}

/** Descending, except cost per result (ascending: cheaper first). Unavailable values always last. */
function compareCampaigns(a: CampaignPerformance, b: CampaignPerformance, key: SortKey) {
  const left = sortValue(a, key);
  const right = sortValue(b, key);
  if (left === null && right === null) return b.spend - a.spend;
  if (left === null) return 1;
  if (right === null) return -1;
  return key === "cost_per_result" ? left - right : right - left;
}

/**
 * Campaign table. Each row uses its platform's metrics: Google clicks, CTR,
 * CPC, conversions and ROAS; Meta link CTR, cost per link click, the result
 * of its objective and purchase ROAS (sales objectives only).
 */
export function CampaignTable({ campaigns }: { campaigns: CampaignPerformance[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[920px] text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th scope="col" className="px-5 py-3 font-medium">Campaign</th>
            <th scope="col" className="px-3 py-3 font-medium">Status</th>
            <th scope="col" className="px-3 py-3 text-right font-medium">Spend</th>
            <th scope="col" className="px-3 py-3 text-right font-medium">Impr.</th>
            <th scope="col" className="px-3 py-3 text-right font-medium" title="Google: clicks / impressions. Meta: link clicks / impressions.">CTR</th>
            <th scope="col" className="px-3 py-3 text-right font-medium" title="Google: cost per click. Meta: cost per link click.">CPC</th>
            <th scope="col" className="px-3 py-3 text-right font-medium">Result</th>
            <th scope="col" className="px-3 py-3 text-right font-medium">Cost / result</th>
            <th scope="col" className="px-5 py-3 text-right font-medium">ROAS</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {campaigns.map((campaign) => {
            const view = campaignView(campaign);
            const unavailable = campaign.provider === "meta" && !view.available;
            const value = (number: number | null, format: (n: number) => string) => (number === null ? (unavailable ? UNAVAILABLE : "–") : format(number));
            return (
              <tr key={campaign.campaign_id} className="hover:bg-slate-50/70">
                <td className="max-w-[300px] px-5 py-3">
                  <p className="truncate font-medium text-ink-950">{campaign.campaign_name ?? campaign.external_campaign_id}</p>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                    <ProviderBadge provider={campaign.provider} />
                    {campaign.objective && <span className="truncate">{campaign.objective.replace(/^OUTCOME_/, "").replace(/_/g, " ").toLowerCase()}</span>}
                  </div>
                </td>
                <td className="px-3 py-3"><StatusBadge status={campaign.campaign_status?.toLowerCase() === "enabled" ? "active" : campaign.campaign_status?.toLowerCase()} /></td>
                <td className="px-3 py-3 text-right tabular-nums">{formatMoney(campaign.spend, campaign.currency, 0)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{formatNumber(campaign.impressions)}</td>
                <td className="px-3 py-3 text-right tabular-nums" title={view.ctrLabel}>{value(view.ctr, (n) => formatPercent(n))}</td>
                <td className="px-3 py-3 text-right tabular-nums" title={view.cpcLabel}>{value(view.cpc, (n) => formatMoney(n, campaign.currency))}</td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {view.result ? (view.result.count === null ? UNAVAILABLE : `${formatNumber(view.result.count, 0)} ${view.result.label.toLowerCase()}`) : "–"}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{view.result ? value(view.result.cost, (n) => formatMoney(n, campaign.currency)) : "–"}</td>
                <td className="px-5 py-3 text-right tabular-nums" title={view.roasLabel ?? "Not applicable"}>{view.roasLabel ? value(view.roas, (n) => formatMultiple(n)) : "–"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="px-5 py-2 text-xs text-slate-500">Meta rows use link clicks and the result of the campaign's objective; ROAS for Meta is purchase ROAS on sales campaigns only.</p>
    </div>
  );
}
