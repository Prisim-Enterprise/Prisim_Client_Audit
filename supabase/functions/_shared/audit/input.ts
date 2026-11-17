// Maps database RPC rows (get_campaign_performance / get_daily_performance)
// to the engine input. Shared by the run-audit Edge Function and demo mode.

import type { AuditAccount, AuditCampaign, AuditDailyRow, AuditInput, Provider } from "./types.ts";

export type CampaignPerformanceRow = {
  campaign_id: string;
  ad_account_id: string;
  provider: string;
  account_name: string | null;
  external_campaign_id: string;
  campaign_name: string | null;
  objective: string | null;
  campaign_status: string | null;
  channel_type: string | null;
  bid_strategy: string | null;
  daily_budget: number | string | null;
  currency: string | null;
  impressions: number | string;
  reach: number | string;
  clicks: number | string;
  spend: number | string;
  conversions: number | string;
  conversion_value: number | string;
  active_days: number | string;
};

export type DailyPerformanceRow = {
  metric_date: string;
  ad_account_id: string;
  provider: string;
  currency: string | null;
  impressions: number | string;
  reach: number | string;
  clicks: number | string;
  spend: number | string;
  conversions: number | string;
  conversion_value: number | string;
};

export type AccountRow = {
  id: string;
  provider: string;
  account_name: string | null;
  external_account_id: string;
  currency: string | null;
};

/** PostgREST returns NUMERIC as strings and BIGINT as numbers; normalize both. */
export function num(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function provider(value: string): Provider {
  if (value === "meta" || value === "google") return value;
  throw new Error(`Unsupported provider: ${value}`);
}

export function toAuditCampaign(row: CampaignPerformanceRow): AuditCampaign {
  return {
    id: row.campaign_id,
    adAccountId: row.ad_account_id,
    provider: provider(row.provider),
    name: row.campaign_name?.trim() || `Campaign ${row.external_campaign_id}`,
    objective: row.objective,
    status: row.campaign_status,
    channelType: row.channel_type,
    bidStrategy: row.bid_strategy,
    dailyBudget: row.daily_budget === null ? null : num(row.daily_budget),
    impressions: num(row.impressions),
    reach: num(row.reach),
    clicks: num(row.clicks),
    spend: num(row.spend),
    conversions: num(row.conversions),
    conversionValue: num(row.conversion_value),
    activeDays: num(row.active_days),
  };
}

export function toAuditDaily(row: DailyPerformanceRow): AuditDailyRow {
  return {
    date: row.metric_date,
    adAccountId: row.ad_account_id,
    impressions: num(row.impressions),
    reach: num(row.reach),
    clicks: num(row.clicks),
    spend: num(row.spend),
    conversions: num(row.conversions),
    conversionValue: num(row.conversion_value),
  };
}

export function buildAuditInput(options: {
  tenantName: string;
  periodStart: string;
  periodEnd: string;
  accounts: AccountRow[];
  campaigns: CampaignPerformanceRow[];
  daily: DailyPerformanceRow[];
}): AuditInput {
  const accounts: AuditAccount[] = options.accounts.map((account) => ({
    id: account.id,
    provider: provider(account.provider),
    name: account.account_name?.trim() || account.external_account_id,
    currency: account.currency,
  }));
  const selected = new Set(accounts.map((account) => account.id));
  return {
    tenantName: options.tenantName,
    periodStart: options.periodStart,
    periodEnd: options.periodEnd,
    accounts,
    campaigns: options.campaigns.filter((row) => selected.has(row.ad_account_id)).map(toAuditCampaign),
    daily: options.daily.filter((row) => selected.has(row.ad_account_id)).map(toAuditDaily),
  };
}
