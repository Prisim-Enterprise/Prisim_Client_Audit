// Shared audit types. Pure TypeScript: used by the run-audit and
// generate-report Edge Functions (Deno) and by the frontend (Vite).

export type Provider = "meta" | "google";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type FindingCategory =
  | "tracking"
  | "efficiency"
  | "structure"
  | "budget"
  | "engagement"
  | "trend"
  | "data_quality";

export type AuditAccount = {
  id: string;
  provider: Provider;
  name: string;
  currency: string | null;
};

export type AuditCampaign = {
  id: string;
  adAccountId: string;
  provider: Provider;
  name: string;
  objective: string | null;
  status: string | null;
  channelType: string | null;
  bidStrategy: string | null;
  dailyBudget: number | null;
  impressions: number;
  reach: number;
  clicks: number;
  spend: number;
  conversions: number;
  conversionValue: number;
  activeDays: number;
};

export type AuditDailyRow = {
  date: string; // YYYY-MM-DD
  adAccountId: string;
  impressions: number;
  reach: number;
  clicks: number;
  spend: number;
  conversions: number;
  conversionValue: number;
};

export type AuditInput = {
  tenantName: string;
  periodStart: string;
  periodEnd: string;
  accounts: AuditAccount[];
  campaigns: AuditCampaign[];
  daily: AuditDailyRow[];
};

export type Totals = {
  impressions: number;
  reach: number;
  clicks: number;
  spend: number;
  conversions: number;
  conversionValue: number;
};

export type DerivedKpis = Totals & {
  ctr: number | null; // clicks / impressions
  cpc: number | null; // spend / clicks
  cpm: number | null; // spend / impressions * 1000
  cpa: number | null; // spend / conversions
  conversionRate: number | null; // conversions / clicks
  roas: number | null; // conversionValue / spend
};

export type AccountKpis = DerivedKpis & {
  adAccountId: string;
  provider: Provider;
  name: string;
  currency: string | null;
  campaignCount: number;
  activeCampaignCount: number;
};

export type AuditFinding = {
  ruleId: string;
  category: FindingCategory;
  severity: Severity;
  platform: Provider | null;
  adAccountId: string | null;
  campaignId: string | null;
  title: string;
  description: string;
  recommendation: string;
  evidence: Record<string, string | number | boolean | null>;
  estimatedImpact: number | null;
  impactCurrency: string | null;
};

export type AuditResult = {
  engineVersion: string;
  overallScore: number;
  platformScores: Partial<Record<Provider, number>>;
  categoryScores: Record<FindingCategory, number>;
  kpis: {
    currency: string | null; // null when accounts use different currencies
    totals: DerivedKpis | null; // null when currencies differ
    accounts: AccountKpis[];
    periodDays: number;
    dataDays: number;
  };
  findings: AuditFinding[];
  summary: string;
};
