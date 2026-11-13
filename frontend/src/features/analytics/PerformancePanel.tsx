import { formatMoney, formatMultiple, formatNumber, formatPercent, ratio } from "@functions/_shared/format.ts";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownUp, BarChart3, MousePointerClick, Target, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { BarList, TrendChart } from "../../components/charts/TrendChart";
import { ProviderBadge, StatusBadge } from "../../components/ui/Badge";
import { Card } from "../../components/ui/Card";
import { Select, Tabs } from "../../components/ui/Controls";
import { LoadingState } from "../../components/ui/LoadingState";
import { EmptyState, ErrorState, SectionCard, StatTile } from "../../components/ui/States";
import { currenciesOf, dailyTotals, presetRange, RANGE_PRESETS, type RangePreset, totalsFromCampaigns } from "../../lib/analytics";
import { queryKeys, useApi } from "../../lib/api/ApiProvider";
import type { AdAccount, CampaignPerformance } from "../../lib/api/types";

type Metric = "spend" | "conversions" | "clicks" | "cpa";
type SortKey = "spend" | "conversions" | "cpa" | "ctr" | "roas";

export function PerformancePanel({ tenantId, accounts, compact = false }: { tenantId: string; accounts: AdAccount[]; compact?: boolean }) {
  const api = useApi();
  const [preset, setPreset] = useState<RangePreset>("30");
  const currencies = currenciesOf(accounts);
  const mixedCurrency = currencies.length > 1;
  const [accountId, setAccountId] = useState<string>(mixedCurrency ? accounts[0]?.id ?? "" : "");
  const [metric, setMetric] = useState<Metric>("spend");
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
  const totals = totalsFromCampaigns(campaigns);
  const days = dailyTotals(dailyQuery.data ?? [], range);
  const money = (value: number | null) => formatMoney(value, currency, 0);

  const points = days.map((day) => ({
    date: day.date,
    value: metric === "spend"
      ? day.spend
      : metric === "conversions"
      ? day.conversions
      : metric === "clicks"
      ? day.clicks
      : day.conversions > 0
      ? day.spend / day.conversions
      : null,
  }));

  const sorted = [...campaigns]
    .filter((campaign) => campaign.spend > 0 || campaign.impressions > 0)
    .sort((a, b) => sortValue(b, sort) - sortValue(a, sort));

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
      ) : campaigns.length === 0 || totals.impressions === 0 ? (
        <Card>
          <EmptyState icon={<BarChart3 />} title="No performance data for this period" description="Data appears after the first successful sync of a selected ad account." />
        </Card>
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label="Spend" value={money(totals.spend)} icon={<Wallet />} detail={`${formatNumber(totals.impressions)} impressions · CPM ${formatMoney(totals.cpm, currency)}`} />
            <StatTile label="Conversions" value={formatNumber(totals.conversions, 0)} icon={<Target />} detail={`Conversion rate ${formatPercent(totals.conversionRate)}`} />
            <StatTile label="Cost per conversion" value={formatMoney(totals.cpa, currency)} icon={<ArrowDownUp />} detail={totals.conversionValue > 0 ? `ROAS ${formatMultiple(totals.roas)}` : "Conversion value not tracked"} />
            <StatTile label="Clicks" value={formatNumber(totals.clicks)} icon={<MousePointerClick />} detail={`CTR ${formatPercent(totals.ctr)} · CPC ${formatMoney(totals.cpc, currency)}`} />
          </section>

          <div className={compact ? "space-y-5" : "grid gap-5 xl:grid-cols-[1.6fr_1fr]"}>
            <SectionCard
              title="Daily trend"
              actions={
                <div className="w-full sm:w-auto">
                  <Tabs
                    label="Trend metric"
                    value={metric}
                    onChange={setMetric}
                    items={[
                      { value: "spend", label: "Spend" },
                      { value: "conversions", label: "Conversions" },
                      { value: "clicks", label: "Clicks" },
                      { value: "cpa", label: "Cost / conv." },
                    ]}
                  />
                </div>
              }
              bodyClassName="px-3 py-4 sm:px-5"
            >
              {dailyQuery.isLoading ? <LoadingState /> : dailyQuery.error ? <ErrorState error={dailyQuery.error} /> : (
                <TrendChart
                  points={points}
                  label={{ spend: "Spend", conversions: "Conversions", clicks: "Clicks", cpa: "Cost per conversion" }[metric]}
                  format={(value) => (metric === "spend" || metric === "cpa" ? formatMoney(value, currency, 0) : formatNumber(value, 0))}
                />
              )}
            </SectionCard>
            <SectionCard title="Spend by campaign" description="Top campaigns in the period" bodyClassName="p-5 sm:p-6">
              <BarList
                format={(value) => money(value)}
                items={sorted.slice(0, 6).map((campaign) => ({
                  key: campaign.campaign_id,
                  label: campaign.campaign_name ?? campaign.external_campaign_id,
                  value: campaign.spend,
                  detail: `${formatNumber(campaign.conversions, 0)} conversions · ${formatPercent(ratio(campaign.spend, totals.spend), 0)} of spend`,
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
                  <option value="conversions">Sort by conversions</option>
                  <option value="cpa">Sort by cost / conversion</option>
                  <option value="ctr">Sort by CTR</option>
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

function sortValue(campaign: CampaignPerformance, key: SortKey) {
  switch (key) {
    case "spend":
      return campaign.spend;
    case "conversions":
      return campaign.conversions;
    case "cpa":
      return ratio(campaign.spend, campaign.conversions) ?? -1;
    case "ctr":
      return ratio(campaign.clicks, campaign.impressions) ?? -1;
    case "roas":
      return ratio(campaign.conversion_value, campaign.spend) ?? -1;
  }
}

export function CampaignTable({ campaigns }: { campaigns: CampaignPerformance[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th scope="col" className="px-5 py-3 font-medium">Campaign</th>
            <th scope="col" className="px-3 py-3 font-medium">Status</th>
            <th scope="col" className="px-3 py-3 text-right font-medium">Spend</th>
            <th scope="col" className="px-3 py-3 text-right font-medium">Impr.</th>
            <th scope="col" className="px-3 py-3 text-right font-medium">CTR</th>
            <th scope="col" className="px-3 py-3 text-right font-medium">CPC</th>
            <th scope="col" className="px-3 py-3 text-right font-medium">Conv.</th>
            <th scope="col" className="px-3 py-3 text-right font-medium">Cost / conv.</th>
            <th scope="col" className="px-5 py-3 text-right font-medium">ROAS</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {campaigns.map((campaign) => (
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
              <td className="px-3 py-3 text-right tabular-nums">{formatPercent(ratio(campaign.clicks, campaign.impressions))}</td>
              <td className="px-3 py-3 text-right tabular-nums">{formatMoney(ratio(campaign.spend, campaign.clicks), campaign.currency)}</td>
              <td className="px-3 py-3 text-right tabular-nums">{formatNumber(campaign.conversions, 0)}</td>
              <td className="px-3 py-3 text-right tabular-nums">{formatMoney(ratio(campaign.spend, campaign.conversions), campaign.currency)}</td>
              <td className="px-5 py-3 text-right tabular-nums">{campaign.conversion_value > 0 ? formatMultiple(ratio(campaign.conversion_value, campaign.spend)) : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
