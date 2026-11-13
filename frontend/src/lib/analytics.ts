import { deriveKpis } from "@functions/_shared/audit/engine.ts";
import type { DerivedKpis } from "@functions/_shared/audit/types.ts";
import { addDays, isoDate } from "@functions/_shared/format.ts";
import type { CampaignPerformance, DailyPerformance, DateRange } from "./api/types";

export const RANGE_PRESETS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
] as const;

export type RangePreset = (typeof RANGE_PRESETS)[number]["value"];

/** Complete days only: ranges end yesterday (platforms restate today's numbers). */
export function presetRange(days: number, today = new Date()): DateRange {
  const to = isoDate(new Date(today.getTime() - 86_400_000));
  return { from: addDays(to, -(days - 1)), to };
}

export function totalsFromCampaigns(rows: CampaignPerformance[]): DerivedKpis {
  return deriveKpis(rows.reduce(
    (acc, row) => ({
      impressions: acc.impressions + row.impressions,
      reach: acc.reach + row.reach,
      clicks: acc.clicks + row.clicks,
      spend: acc.spend + row.spend,
      conversions: acc.conversions + row.conversions,
      conversionValue: acc.conversionValue + row.conversion_value,
    }),
    { impressions: 0, reach: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0 },
  ));
}

export type DailyTotals = {
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
};

/** One row per day in the range (zero-filled) so gaps are visible on charts. */
export function dailyTotals(rows: DailyPerformance[], range: DateRange): DailyTotals[] {
  const map = new Map<string, DailyTotals>();
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) {
    map.set(day, { date: day, spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 });
  }
  for (const row of rows) {
    const current = map.get(row.metric_date);
    if (!current) continue;
    current.spend += row.spend;
    current.impressions += row.impressions;
    current.clicks += row.clicks;
    current.conversions += row.conversions;
    current.conversionValue += row.conversion_value;
  }
  return [...map.values()];
}

export function currenciesOf(rows: Array<{ currency: string | null }>): string[] {
  return [...new Set(rows.map((row) => row.currency ?? "").filter(Boolean))];
}

export const CATEGORY_LABELS: Record<string, string> = {
  tracking: "Conversion tracking",
  efficiency: "Cost efficiency",
  engagement: "Engagement & creative",
  structure: "Account structure",
  budget: "Budget management",
  trend: "Performance trend",
  data_quality: "Data quality",
};

export function formatDate(value: string | null | undefined) {
  if (!value) return "–";
  const date = value.length === 10 ? new Date(`${value}T00:00:00Z`) : new Date(value);
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: value.length === 10 ? "UTC" : undefined });
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return "–";
  return new Date(value).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function relativeTime(value: string | null | undefined, now = Date.now()) {
  if (!value) return "never";
  const seconds = Math.round((now - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function formatBytes(value: number | null | undefined) {
  if (!value) return "–";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
}
