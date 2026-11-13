// SYNTHETIC DEMO FIXTURES
//
// Fictional businesses and generated numbers for UI development and demos.
// Loaded only in the `demo` Vite mode (never in production builds), never
// written to Supabase, and labelled as synthetic everywhere they appear.

import { addDays, isoDate } from "@functions/_shared/format.ts";
import type {
  AdAccount,
  CampaignPerformance,
  Connection,
  Invitation,
  Member,
  Provider,
  SyncJob,
  Tenant,
} from "../lib/api/types";

export const DEMO_LABEL = "Synthetic demo data";

export type DemoCampaign = Omit<
  CampaignPerformance,
  "impressions" | "reach" | "clicks" | "spend" | "conversions" | "conversion_value" | "active_days"
> & { tenant_id: string };

export type DemoMetric = {
  tenant_id: string;
  ad_account_id: string;
  campaign_id: string;
  metric_date: string;
  impressions: number;
  reach: number;
  clicks: number;
  spend: number;
  conversions: number;
  conversion_value: number;
};

type CampaignSpec = {
  name: string;
  objective: string;
  status: string;
  channel: string | null;
  bid: string | null;
  budget: number | null;
  dailySpend: number;
  ctr: number;
  cpm: number;
  cvr: number;
  value: number;
  frequency: number;
  /** spend multiplier reached on the last day (linear) */
  spendTrend?: number;
  /** cost-per-result multiplier reached on the last day (linear) */
  costTrend?: number;
  /** no delivery at all */
  idle?: boolean;
};

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const id = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const DEMO_TENANT_IDS = {
  northwind: "d1000000-0000-4000-8000-000000000001",
  harbor: "d2000000-0000-4000-8000-000000000002",
  cedar: "d3000000-0000-4000-8000-000000000003",
};

export const DEMO_USERS = {
  staff: { id: "d9000000-0000-4000-8000-000000000001", email: "staff.demo@prisim.example", name: "Asha (Demo Staff)" },
  owner: { id: "d9000000-0000-4000-8000-000000000002", email: "owner.demo@northwind.example", name: "Rohan (Demo Owner)" },
  viewer: { id: "d9000000-0000-4000-8000-000000000003", email: "viewer.demo@northwind.example", name: "Meera (Demo Viewer)" },
  harborOwner: { id: "d9000000-0000-4000-8000-000000000004", email: "owner.demo@harbor.example", name: "Sam (Demo Owner)" },
};

const created = "2026-08-01T09:00:00.000Z";

export function demoTenants(): Tenant[] {
  return [
    {
      id: DEMO_TENANT_IDS.northwind,
      business_name: "Northwind Dental (Demo)",
      slug: "northwind-dental-demo",
      email: "owner.demo@northwind.example",
      status: "active",
      industry: "Healthcare",
      website: "https://northwind.example",
      primary_contact_name: "Rohan (Demo Owner)",
      created_at: created,
      updated_at: created,
    },
    {
      id: DEMO_TENANT_IDS.harbor,
      business_name: "Harbor Realty (Demo)",
      slug: "harbor-realty-demo",
      email: "owner.demo@harbor.example",
      status: "active",
      industry: "Real estate",
      website: "https://harbor.example",
      primary_contact_name: "Sam (Demo Owner)",
      created_at: created,
      updated_at: created,
    },
    {
      id: DEMO_TENANT_IDS.cedar,
      business_name: "Cedar Outfitters (Demo)",
      slug: "cedar-outfitters-demo",
      email: null,
      status: "suspended",
      industry: "Retail",
      website: null,
      primary_contact_name: null,
      created_at: created,
      updated_at: created,
    },
  ];
}

export function demoMembers(): Record<string, Member[]> {
  const member = (user: { id: string; email: string; name: string }, role: Member["role"]): Member => ({
    user_id: user.id,
    email: user.email,
    full_name: user.name,
    role,
    status: "active",
    created_at: created,
    updated_at: created,
  });
  return {
    [DEMO_TENANT_IDS.northwind]: [member(DEMO_USERS.owner, "owner"), member(DEMO_USERS.viewer, "viewer")],
    [DEMO_TENANT_IDS.harbor]: [member(DEMO_USERS.harborOwner, "owner")],
    [DEMO_TENANT_IDS.cedar]: [],
  };
}

export function demoInvitations(): Invitation[] {
  return [{
    id: id("d8000000", 1),
    tenant_id: DEMO_TENANT_IDS.northwind,
    email: "marketing.demo@northwind.example",
    role: "manager",
    status: "pending",
    expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    created_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  }];
}

type AccountSpec = {
  account: AdAccount;
  campaigns: CampaignSpec[];
};

function accountSpecs(): AccountSpec[] {
  const account = (n: number, tenant: string, connection: string, provider: Provider, external: string, name: string, currency: string): AdAccount => ({
    id: id("da000000", n),
    tenant_id: tenant,
    connection_id: connection,
    provider,
    external_account_id: external,
    account_name: name,
    currency,
    timezone: currency === "INR" ? "Asia/Kolkata" : "America/New_York",
    status: "active",
    sync_enabled: true,
    last_synced_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  });
  return [
    {
      account: account(1, DEMO_TENANT_IDS.northwind, id("dc000000", 1), "meta", "act_100000000000001", "Northwind Dental - Meta (Demo)", "INR"),
      campaigns: [
        { name: "Teeth Whitening - Leads", objective: "OUTCOME_LEADS", status: "ACTIVE", channel: "AUCTION", bid: "LOWEST_COST_WITHOUT_CAP", budget: 4000, dailySpend: 3600, ctr: 0.0135, cpm: 180, cvr: 0.07, value: 0, frequency: 1.6 },
        { name: "Implants - Retargeting", objective: "OUTCOME_SALES", status: "ACTIVE", channel: "AUCTION", bid: "LOWEST_COST_WITHOUT_CAP", budget: 1500, dailySpend: 1300, ctr: 0.011, cpm: 260, cvr: 0.035, value: 2100, frequency: 4.6 },
        { name: "Brand Awareness - Video", objective: "OUTCOME_AWARENESS", status: "ACTIVE", channel: "AUCTION", bid: null, budget: 1200, dailySpend: 1000, ctr: 0.0038, cpm: 90, cvr: 0, value: 0, frequency: 2.1 },
        { name: "Invisalign Leads - Broad", objective: "OUTCOME_LEADS", status: "ACTIVE", channel: "AUCTION", bid: "LOWEST_COST_WITHOUT_CAP", budget: 1800, dailySpend: 1700, ctr: 0.008, cpm: 210, cvr: 0.012, value: 0, frequency: 1.9 },
        { name: "Clinic Launch - Old Creative", objective: "OUTCOME_TRAFFIC", status: "ACTIVE", channel: "AUCTION", bid: null, budget: 500, dailySpend: 0, ctr: 0, cpm: 0, cvr: 0, value: 0, frequency: 1, idle: true },
      ],
    },
    {
      account: account(2, DEMO_TENANT_IDS.northwind, id("dc000000", 2), "google", "1234567890", "Northwind Dental - Google Ads (Demo)", "INR"),
      campaigns: [
        { name: "Search - Dentist Near Me", objective: "SEARCH", status: "ENABLED", channel: "SEARCH", bid: "MANUAL_CPC", budget: 3000, dailySpend: 2800, ctr: 0.064, cpm: 950, cvr: 0.09, value: 0, frequency: 1, costTrend: 1.7 },
        { name: "Search - Emergency Dentist", objective: "SEARCH", status: "ENABLED", channel: "SEARCH", bid: "MAXIMIZE_CONVERSIONS", budget: 1500, dailySpend: 1400, ctr: 0.071, cpm: 1100, cvr: 0.11, value: 0, frequency: 1, costTrend: 1.5 },
        { name: "Display - Remarketing", objective: "DISPLAY", status: "ENABLED", channel: "DISPLAY", bid: "MANUAL_CPM", budget: 800, dailySpend: 700, ctr: 0.0015, cpm: 55, cvr: 0.02, value: 0, frequency: 1 },
        { name: "PMax - Treatments", objective: "PERFORMANCE_MAX", status: "ENABLED", channel: "PERFORMANCE_MAX", bid: "MAXIMIZE_CONVERSIONS", budget: 5000, dailySpend: 1500, ctr: 0.009, cpm: 160, cvr: 0.05, value: 0, frequency: 1, spendTrend: 1.4 },
      ],
    },
    {
      account: account(3, DEMO_TENANT_IDS.harbor, id("dc000000", 3), "meta", "act_200000000000001", "Harbor Realty - Meta (Demo)", "USD"),
      campaigns: [
        { name: "Waterfront Listings - Traffic", objective: "OUTCOME_TRAFFIC", status: "ACTIVE", channel: "AUCTION", bid: null, budget: 120, dailySpend: 110, ctr: 0.012, cpm: 9, cvr: 0, value: 0, frequency: 1.8 },
        { name: "Open House - Leads", objective: "OUTCOME_LEADS", status: "ACTIVE", channel: "AUCTION", bid: "LOWEST_COST_WITHOUT_CAP", budget: 90, dailySpend: 85, ctr: 0.009, cpm: 11, cvr: 0, value: 0, frequency: 2.2, spendTrend: 2.2 },
        { name: "Seller Valuation - Leads", objective: "OUTCOME_LEADS", status: "ACTIVE", channel: "AUCTION", bid: "LOWEST_COST_WITHOUT_CAP", budget: 60, dailySpend: 40, ctr: 0.006, cpm: 12, cvr: 0, value: 0, frequency: 3.1 },
      ],
    },
  ];
}

export function demoConnections(): Connection[] {
  const connection = (n: number, tenant: string, provider: Provider, name: string): Connection => ({
    id: id("dc000000", n),
    tenant_id: tenant,
    provider,
    provider_account_id: provider === "meta" ? `demo-meta-user-${n}` : null,
    account_name: name,
    status: "connected",
    token_expires_at: provider === "meta" ? new Date(Date.now() + 40 * 86_400_000).toISOString() : null,
    scopes: provider === "meta" ? ["ads_read", "business_management"] : ["https://www.googleapis.com/auth/adwords"],
    created_at: created,
    updated_at: created,
  });
  return [
    connection(1, DEMO_TENANT_IDS.northwind, "meta", "Demo Meta login"),
    connection(2, DEMO_TENANT_IDS.northwind, "google", "Google Ads"),
    connection(3, DEMO_TENANT_IDS.harbor, "meta", "Demo Meta login"),
  ];
}

export function demoSyncJobs(): SyncJob[] {
  return demoConnections().map((connection, index) => ({
    id: id("db000000", index + 1),
    tenant_id: connection.tenant_id,
    connection_id: connection.id,
    provider: connection.provider,
    job_type: "daily_sync",
    status: "completed",
    attempts: 1,
    started_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    completed_at: new Date(Date.now() - 3 * 3_600_000 + 40_000).toISOString(),
    error_message: null,
    created_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  }));
}

const HISTORY_DAYS = 120;

export function generateDemoData(today = new Date()): { accounts: AdAccount[]; campaigns: DemoCampaign[]; metrics: DemoMetric[] } {
  const random = mulberry32(20261111);
  const lastDay = isoDate(new Date(today.getTime() - 86_400_000));
  const firstDay = addDays(lastDay, -(HISTORY_DAYS - 1));
  const accounts: AdAccount[] = [];
  const campaigns: DemoCampaign[] = [];
  const metrics: DemoMetric[] = [];
  let campaignNumber = 0;

  for (const spec of accountSpecs()) {
    accounts.push(spec.account);
    for (const campaignSpec of spec.campaigns) {
      campaignNumber++;
      const campaignId = id("dd000000", campaignNumber);
      campaigns.push({
        tenant_id: spec.account.tenant_id,
        campaign_id: campaignId,
        ad_account_id: spec.account.id,
        provider: spec.account.provider,
        account_name: spec.account.account_name,
        external_campaign_id: String(9_000_000 + campaignNumber),
        campaign_name: campaignSpec.name,
        objective: campaignSpec.objective,
        campaign_status: campaignSpec.status,
        channel_type: campaignSpec.channel,
        bid_strategy: campaignSpec.bid,
        daily_budget: campaignSpec.budget,
        currency: spec.account.currency,
      });
      if (campaignSpec.idle) continue;
      for (let day = 0; day < HISTORY_DAYS; day++) {
        const progress = day / (HISTORY_DAYS - 1);
        const date = addDays(firstDay, day);
        const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
        const weekend = weekday === 0 || weekday === 6 ? 0.82 : 1;
        const spendTrend = 1 + ((campaignSpec.spendTrend ?? 1) - 1) * progress;
        const costTrend = 1 + ((campaignSpec.costTrend ?? 1) - 1) * progress;
        const noise = () => 0.85 + random() * 0.3;
        const spend = campaignSpec.dailySpend * spendTrend * weekend * noise();
        const impressions = Math.round((spend / (campaignSpec.cpm * costTrend)) * 1000);
        const clicks = Math.round(impressions * campaignSpec.ctr * noise());
        const conversions = Math.round(clicks * campaignSpec.cvr * noise() * 10) / 10;
        metrics.push({
          tenant_id: spec.account.tenant_id,
          ad_account_id: spec.account.id,
          campaign_id: campaignId,
          metric_date: date,
          impressions,
          reach: Math.round(impressions / (campaignSpec.frequency * (0.95 + random() * 0.1))),
          clicks,
          spend: Math.round(spend * 100) / 100,
          conversions,
          conversion_value: Math.round(conversions * campaignSpec.value * noise() * 100) / 100,
        });
      }
    }
  }
  return { accounts, campaigns, metrics };
}
