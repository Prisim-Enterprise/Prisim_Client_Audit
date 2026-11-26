import type { PlatformSummary } from "@functions/_shared/analytics/platform.ts";
import { formatMoney, formatMultiple, formatNumber, formatPercent } from "@functions/_shared/format.ts";
import { ProviderBadge } from "../../components/ui/Badge";
import { Card } from "../../components/ui/Card";

const UNAVAILABLE = "Unavailable";

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold text-ink-950">{value}</p>
      {detail && <p className="mt-0.5 truncate text-xs text-slate-500">{detail}</p>}
    </div>
  );
}

/**
 * One card per platform (and currency). Google and Meta metrics are never
 * combined; Meta uses link clicks and results per objective.
 */
export function PlatformSummaries({ summaries, compact = false }: { summaries: PlatformSummary[]; compact?: boolean }) {
  return (
    <div className="space-y-4">
      {summaries.map((summary) => {
        const money = (value: number | null, digits = 2) => formatMoney(value, summary.currency, digits);
        const tiles: Array<{ label: string; value: string; detail?: string }> = [
          { label: "Spend", value: money(summary.spend, 0), detail: `${formatNumber(summary.impressions)} impressions · CPM ${money(summary.cpm)}` },
        ];
        if (summary.google) {
          const google = summary.google;
          tiles.push(
            { label: "Conversions", value: formatNumber(google.conversions, 0), detail: `Conversion rate ${formatPercent(google.conversionRate)}` },
            { label: "Cost / conversion", value: money(google.costPerConversion), detail: google.conversionValue > 0 ? `ROAS ${formatMultiple(google.roas)}` : "Conversion value not tracked" },
            { label: "Clicks", value: formatNumber(google.clicks), detail: `CTR ${formatPercent(google.ctr)} · CPC ${money(google.cpc)}` },
          );
        }
        if (summary.meta) {
          const meta = summary.meta;
          tiles.push({
            label: "Link clicks",
            value: meta.linkClicks === null ? UNAVAILABLE : formatNumber(meta.linkClicks),
            detail: meta.linkClicks === null ? "Not captured for older data" : `Link CTR ${formatPercent(meta.linkCtr)} · ${money(meta.costPerLinkClick)} per click`,
          });
          for (const result of meta.results) {
            tiles.push({
              label: result.label,
              value: result.count === null ? UNAVAILABLE : formatNumber(result.count, 0),
              detail: result.count === null
                ? `${result.campaigns} campaign(s); not captured for older data`
                : `${money(result.cost)} per ${result.singular}` + (result.family === "sales" ? ` · Purchase ROAS ${meta.purchaseRoas === null ? UNAVAILABLE : formatMultiple(meta.purchaseRoas)}` : ""),
            });
          }
        }
        const visible = compact ? tiles.slice(0, 3) : tiles;
        return (
          <Card key={`${summary.provider}-${summary.currency ?? ""}`} className="p-4" data-testid={`platform-summary-${summary.provider}`}>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <ProviderBadge provider={summary.provider} />
              <span className="text-sm font-semibold text-ink-950">{summary.provider === "meta" ? "Meta Ads" : "Google Ads"}</span>
              {summary.currency && <span className="text-xs text-slate-500">{summary.currency}</span>}
              {summary.meta && summary.meta.unavailableCampaigns > 0 && (
                <span className="text-xs text-amber-800">{summary.meta.unavailableCampaigns} campaign(s) without link-click and result data (synced before it was stored)</span>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {visible.map((tile) => <Tile key={tile.label} {...tile} />)}
            </div>
          </Card>
        );
      })}
      {summaries.length > 1 && <p className="text-xs text-slate-500">Each platform is reported separately; conversions, clicks and spend are not added across platforms or currencies.</p>}
    </div>
  );
}
