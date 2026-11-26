// @vitest-environment node
// Engine 2.0: data quality, evidence-based scoring and the rule fixes.
// All data here is synthetic. The Cleanwell cases reproduce the structure of
// the real production records (one ENABLED App campaign, INR 700 daily budget,
// a completed manual sync with 0 metric rows) without inventing performance.
import { runAudit, scoreLabel } from "@functions/_shared/audit/engine.ts";
import { buildAuditInput, toSyncRuns } from "@functions/_shared/audit/input.ts";
import { penalty } from "@functions/_shared/audit/scoring.ts";
import type {
  AccountDiagnosticsInput,
  AuditAccount,
  AuditCampaign,
  AuditDailyRow,
  AuditInput,
  CampaignContext,
  SyncRunRecord,
} from "@functions/_shared/audit/types.ts";
import { addDays } from "@functions/_shared/format.ts";
import { describe, expect, it } from "vitest";

const START = "2026-10-26";
const END = "2026-11-24";
const DAYS = 30;
const GENERATED = "2026-11-26T09:00:00Z";
const META = "a0000000-0000-4000-8000-000000000001";
const GOOGLE = "a0000000-0000-4000-8000-000000000002";
const CLEANWELL = "b2406169-7f7e-4eea-82c2-d2b039b191a1";

type Day = Partial<Omit<AuditDailyRow, "date" | "adAccountId">> | null;

type CampaignSpec = Partial<Omit<AuditCampaign, "impressions" | "reach" | "clicks" | "spend" | "conversions" | "conversionValue" | "activeDays">> & {
  id: string;
  /** Metrics per day index (0..29); null = no row for that day. */
  day?: (index: number) => Day;
};

const DEFAULT_DAY = { impressions: 2000, reach: 1500, clicks: 40, spend: 400, conversions: 2, conversionValue: 0 };

function dates() {
  return Array.from({ length: DAYS }, (_, index) => addDays(START, index));
}

/** Builds consistent campaigns + account daily rows from per-day campaign metrics. */
function build(account: AuditAccount, specs: CampaignSpec[]) {
  const campaigns: AuditCampaign[] = [];
  const daily = new Map<string, AuditDailyRow>();
  for (const spec of specs) {
    const totals = { impressions: 0, reach: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0, activeDays: 0 };
    dates().forEach((date, index) => {
      const value = spec.day ? spec.day(index) : DEFAULT_DAY;
      if (!value) return;
      const metrics = { ...DEFAULT_DAY, ...value };
      for (const key of ["impressions", "reach", "clicks", "spend", "conversions", "conversionValue"] as const) totals[key] += metrics[key];
      if (metrics.impressions > 0 || metrics.spend > 0) totals.activeDays += 1;
      const row = daily.get(date) ?? { date, adAccountId: account.id, impressions: 0, reach: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0, currency: account.currency };
      for (const key of ["impressions", "reach", "clicks", "spend", "conversions", "conversionValue"] as const) row[key] += metrics[key];
      daily.set(date, row);
    });
    const { day: _day, ...rest } = spec;
    campaigns.push({
      adAccountId: account.id,
      provider: account.provider,
      name: spec.id,
      objective: account.provider === "meta" ? "OUTCOME_SALES" : "SEARCH",
      status: account.provider === "meta" ? "ACTIVE" : "ENABLED",
      channelType: account.provider === "meta" ? "AUCTION" : "SEARCH",
      bidStrategy: account.provider === "meta" ? null : "MAXIMIZE_CONVERSIONS",
      dailyBudget: null,
      externalId: spec.id,
      currency: account.currency,
      details: { start: "2026-01-01", primaryStatus: account.provider === "google" ? "ELIGIBLE" : null, capturedAt: "2026-11-25T11:35:23Z" },
      ...totals,
      ...rest,
    });
  }
  return { campaigns, daily: [...daily.values()] };
}

function syncRun(adAccountId: string, overrides: Partial<SyncRunRecord> = {}): SyncRunRecord {
  return {
    adAccountId,
    connectionId: "conn",
    jobType: "manual_sync",
    status: "succeeded",
    completedAt: "2026-11-25T11:35:23Z",
    since: "2026-08-27",
    until: END,
    invalidValues: 0,
    unavailableFields: [],
    error: null,
    legacy: false,
    ...overrides,
  };
}

const metaAccount: AuditAccount = { id: META, provider: "meta", name: "Meta account", currency: "INR" };
const googleAccount: AuditAccount = { id: GOOGLE, provider: "google", name: "Google account", currency: "INR" };

function audit(options: {
  accounts?: Array<{ account: AuditAccount; campaigns: CampaignSpec[] }>;
  syncRuns?: SyncRunRecord[] | undefined;
  diagnostics?: AccountDiagnosticsInput[];
  overrides?: Partial<AuditInput>;
  noSync?: boolean;
}) {
  const sets = options.accounts ?? [{
    account: metaAccount,
    campaigns: [
      { id: "m1", day: () => ({ conversionValue: 1600 }) },
      { id: "m2", day: () => ({ conversionValue: 1600 }) },
      { id: "m3", day: () => ({ conversionValue: 1600 }) },
    ],
  }];
  const built = sets.map((set) => ({ account: set.account, ...build(set.account, set.campaigns) }));
  const input: AuditInput = {
    tenantName: "Test Co",
    periodStart: START,
    periodEnd: END,
    accounts: built.map((item) => item.account),
    campaigns: built.flatMap((item) => item.campaigns),
    daily: built.flatMap((item) => item.daily),
    syncRuns: options.noSync ? undefined : options.syncRuns ?? built.map((item) => syncRun(item.account.id)),
    diagnostics: options.diagnostics,
    generatedAt: GENERATED,
    ...options.overrides,
  };
  return { input, result: runAudit(input) };
}

const ids = (result: ReturnType<typeof runAudit>) => result.findings.map((finding) => finding.ruleId);
const find = (result: ReturnType<typeof runAudit>, ruleId: string) => result.findings.find((finding) => finding.ruleId === ruleId);

// ---------------------------------------------------------------------------
// Cleanwell regression (A-D)
// ---------------------------------------------------------------------------

const cleanwell: AuditAccount = { id: CLEANWELL, provider: "google", name: "Cleanwell Solutions", currency: "INR", externalId: "9574280792", connectionId: "30e0849a", syncEnabled: true, lastSyncedAt: "2026-11-25T11:35:23Z" };

function cleanwellCampaign(details?: CampaignContext): CampaignSpec {
  return {
    id: "24546116371",
    name: "App Campaign - PRISIM- Cleanwell Solutions",
    objective: "MULTI_CHANNEL",
    channelType: "MULTI_CHANNEL",
    status: "ENABLED",
    bidStrategy: "TARGET_CPA",
    dailyBudget: 700,
    details,
    day: () => null,
  };
}

describe("Cleanwell regression", () => {
  it("A: confirmed zero delivery with complete reporting data is unscored, not 99/100", () => {
    const { result } = audit({ accounts: [{ account: cleanwell, campaigns: [cleanwellCampaign()] }] });
    expect(result.overallScore).toBeNull();
    expect(result.scoreStatus).toBe("unscored");
    expect(result.kpis.scoring?.reason).toMatch(/No impressions or spend/);
    const coverage = result.kpis.accounts[0].coverage!;
    expect(coverage).toMatchObject({ periodDays: 30, retrievedDays: 30, daysWithRows: 0, zeroDeliveryDays: 30, missingDays: 0, basis: "sync_record" });
    const account = find(result, "structure.no_account_delivery");
    expect(account).toMatchObject({ basis: "verified", severity: "medium" });
    // The campaign's start date is not stored, so "not active for the whole period" cannot be excluded.
    const campaign = find(result, "structure.no_delivery");
    expect(campaign?.basis).toBe("indicative");
    expect(campaign?.evidence.unavailable).toContain("campaign start and end dates");
    expect(campaign?.evidence.observed).toMatchObject({ daily_budget: 700, status_at_sync: "ENABLED" });
    expect(result.summary).toContain("No account health score was calculated");
    expect(result.summary).not.toMatch(/\d+\/100 \(strong/);
  });

  it("A (production record shape): a legacy job-level sync record gives inferred coverage, still unscored", () => {
    const input = buildAuditInput({
      tenantName: "Cleanwell Solutions",
      periodStart: START,
      periodEnd: END,
      accounts: [{ id: CLEANWELL, provider: "google", account_name: "Cleanwell Solutions", external_account_id: "9574280792", currency: "INR", connection_id: "30e0849a", sync_enabled: true, last_synced_at: "2026-11-25T11:35:23Z", status: "active" }],
      campaigns: [{
        campaign_id: "c-cleanwell", ad_account_id: CLEANWELL, provider: "google", account_name: "Cleanwell Solutions", external_campaign_id: "24546116371",
        campaign_name: "App Campaign - PRISIM- Cleanwell Solutions", objective: "MULTI_CHANNEL", campaign_status: "ENABLED", channel_type: "MULTI_CHANNEL",
        bid_strategy: "TARGET_CPA", daily_budget: "700.0000", currency: "INR", impressions: 0, reach: 0, clicks: 0, spend: "0", conversions: "0", conversion_value: "0", active_days: 0,
      }],
      daily: [],
      syncJobs: [{
        id: "job", connection_id: "30e0849a", job_type: "manual_sync", status: "completed", completed_at: "2026-11-25T11:35:23.304024+00:00", error_message: null,
        stats: { accounts: 1, campaigns: 1, errors: null, failed_accounts: 0, metrics: 0, window: { since: "2026-08-27", until: "2026-11-24" } },
      }],
      generatedAt: GENERATED,
    });
    const result = runAudit(input);
    expect(result.overallScore).toBeNull();
    expect(result.kpis.accounts[0].coverage?.basis).toBe("legacy_sync_record");
    expect(ids(result)).toContain("data_quality.legacy_sync_record");
    expect(ids(result)).toContain("structure.no_account_delivery");
    expect(result.kpis.campaigns?.[0]).toMatchObject({ kind: "app", goal: "app", dailyBudget: 700 });
  });

  it("B: missing reporting data is never treated as zero performance", () => {
    const { result } = audit({ accounts: [{ account: cleanwell, campaigns: [cleanwellCampaign()] }], syncRuns: [] });
    expect(result.overallScore).toBeNull();
    expect(result.kpis.accounts[0].coverage).toMatchObject({ missingDays: 30, zeroDeliveryDays: 0 });
    expect(ids(result)).toContain("data_quality.sync_never_succeeded");
    expect(ids(result)).not.toContain("structure.no_account_delivery");
    expect(ids(result)).not.toContain("structure.no_delivery");
    expect(result.kpis.dataQuality?.level).toBe("none");
  });

  it("C: a failed sync is reported and the account is not presented as a zero-data success", () => {
    const { result } = audit({
      accounts: [{ account: cleanwell, campaigns: [cleanwellCampaign()] }],
      syncRuns: [syncRun(CLEANWELL, { status: "failed", error: "Google Ads denied access to this account." })],
    });
    expect(result.overallScore).toBeNull();
    expect(ids(result)).toEqual(expect.arrayContaining(["data_quality.sync_failed", "data_quality.sync_never_succeeded"]));
    expect(find(result, "data_quality.sync_failed")?.description).toContain("denied access");
    expect(ids(result)).not.toContain("structure.no_account_delivery");
  });

  it("C: partial sync failure across accounts leaves the failed account unscored and the audit provisional", () => {
    const { result } = audit({
      accounts: [
        { account: metaAccount, campaigns: [{ id: "m1", day: () => ({ conversionValue: 1600 }) }, { id: "m2", day: () => ({ conversionValue: 1600 }) }, { id: "m3", day: () => ({ conversionValue: 1600 }) }] },
        { account: cleanwell, campaigns: [cleanwellCampaign()] },
      ],
      syncRuns: [syncRun(META), syncRun(CLEANWELL, { status: "failed", error: "permission denied" })],
    });
    const meta = result.kpis.accounts.find((item) => item.adAccountId === META)!;
    const google = result.kpis.accounts.find((item) => item.adAccountId === CLEANWELL)!;
    expect(meta.scoreStatus).not.toBe("unscored");
    expect(google.scoreStatus).toBe("unscored");
    expect(result.scoreStatus).toBe("provisional");
    expect(result.kpis.scoring?.reason).toContain("1 of 2 account(s) could not be scored");
    expect(result.platformScores.google).toBeUndefined();
    expect(result.platformScores.meta).toBeDefined();
  });

  it("D: a campaign that started late in the period is not reported as idle for the whole period", () => {
    const late = audit({ accounts: [{ account: cleanwell, campaigns: [cleanwellCampaign({ start: "2026-11-20 00:00:00", primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["CAMPAIGN_PENDING"] })] }] });
    expect(ids(late.result)).not.toContain("structure.no_delivery"); // only 5 eligible days
    expect(late.result.overallScore).toBeNull();
    const future = audit({ accounts: [{ account: cleanwell, campaigns: [cleanwellCampaign({ start: "2026-12-01 00:00:00" })] }] });
    expect(ids(future.result)).not.toContain("structure.no_delivery");
    const known = audit({ accounts: [{ account: cleanwell, campaigns: [cleanwellCampaign({ start: "2026-10-01 00:00:00", primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["BUDGET_CONSTRAINED"] })] }] });
    const finding = find(known.result, "structure.no_delivery");
    expect(finding).toMatchObject({ basis: "verified", severity: "high" });
    expect(finding?.description).toContain("NOT_ELIGIBLE (BUDGET_CONSTRAINED)");
  });
});

// ---------------------------------------------------------------------------
// Data quality
// ---------------------------------------------------------------------------

describe("data quality", () => {
  it("scores a complete, consistent account and reports high confidence", () => {
    const { result } = audit({});
    expect(result.scoreStatus).toBe("scored");
    expect(result.overallScore).toBeGreaterThanOrEqual(85);
    expect(result.kpis.dataQuality).toMatchObject({ level: "high", coverageRatio: 1 });
    expect(result.kpis.dataQuality?.confidence).toBe(100);
    expect(result.kpis.lastSuccessfulSync).toBe("2026-11-25T11:35:23Z");
  });

  it("missing dates: days outside every sync window are unknown, per account", () => {
    const { result } = audit({ syncRuns: [syncRun(META, { since: "2026-11-10", until: END })], accounts: [{ account: metaAccount, campaigns: [{ id: "m1", day: (index) => (index >= 15 ? {} : null) }, { id: "m2", day: (index) => (index >= 15 ? {} : null) }, { id: "m3", day: (index) => (index >= 15 ? {} : null) }] }] });
    const coverage = result.kpis.accounts[0].coverage!;
    expect(coverage).toMatchObject({ retrievedDays: 15, missingDays: 15, zeroDeliveryDays: 0 });
    expect(coverage.missingRanges).toEqual(["2026-10-26..2026-11-09"]);
    expect(find(result, "data_quality.missing_days")?.severity).toBe("medium"); // 50% missing = major
    expect(result.scoreStatus).toBe("provisional");
  });

  it("score boundaries on coverage: <50% unscored, 50-89% provisional, >=90% eligible", () => {
    // Rows exist only for retrieved days; the other days are unknown.
    const run = (days: number) => audit({
      syncRuns: [syncRun(META, { since: addDays(END, -(days - 1)), until: END })],
      accounts: [{ account: metaAccount, campaigns: ["m1", "m2", "m3"].map((id) => ({ id, day: (index: number) => (index >= DAYS - days ? { conversionValue: 1600 } : null) })) }],
    }).result;
    expect(run(14).scoreStatus).toBe("unscored");
    expect(run(14).kpis.scoring?.reason).toContain("16 of 30 days were not retrieved");
    expect(run(15).scoreStatus).toBe("provisional");
    expect(run(26).scoreStatus).toBe("provisional");
    expect(run(27).kpis.accounts[0].coverage?.coverageRatio).toBe(0.9);
    expect(run(27).kpis.scoring?.reason).not.toContain("of the period's days are known");
  });

  it("stale sync: the period extends past the newest successful sync", () => {
    const { result } = audit({ overrides: { periodEnd: "2026-12-05", generatedAt: "2026-12-10T08:00:00Z" } });
    expect(ids(result)).toEqual(expect.arrayContaining(["data_quality.stale_sync", "data_quality.missing_days"]));
    expect(result.kpis.accounts[0].coverage?.missingDays).toBe(11);
  });

  it("flags recently synced days that may still change, and periods that include today", () => {
    const { result } = audit({});
    expect(find(result, "data_quality.recent_days_may_change")?.severity).toBe("info");
    const today = audit({ overrides: { periodEnd: "2026-11-26" } });
    expect(ids(today.result)).toContain("data_quality.period_includes_today");
  });

  it("duplicate metric rows are detected and not double counted", () => {
    const base = audit({});
    const doubled = audit({ overrides: { daily: [...base.input.daily, base.input.daily[3]] } });
    expect(find(doubled.result, "data_quality.duplicate_metric_rows")?.description).toContain("1 duplicate");
    expect(doubled.result.kpis.accounts[0].coverage?.daysWithRows).toBe(30);
    expect(doubled.result.scoreStatus).toBe("provisional");
  });

  it("inconsistent campaign identifiers are detected", () => {
    const base = audit({});
    const campaigns = [...base.input.campaigns, { ...base.input.campaigns[0], id: "other-row" }];
    const { result } = audit({ overrides: { campaigns } });
    expect(ids(result)).toContain("data_quality.inconsistent_campaign_id");
  });

  it("inconsistent daily and campaign totals are reported beyond the 1% tolerance only", () => {
    const base = audit({});
    const near = base.input.daily.map((row) => ({ ...row, spend: row.spend * 1.005 }));
    expect(ids(audit({ overrides: { daily: near } }).result)).not.toContain("data_quality.totals_mismatch");
    const far = base.input.daily.map((row, index) => (index < 5 ? { ...row, spend: row.spend * 2 } : row));
    const result = audit({ overrides: { daily: far } }).result;
    expect(find(result, "data_quality.totals_mismatch")?.evidence.observed).toHaveProperty("campaign_spend");
    expect(result.scoreStatus).toBe("provisional");
  });

  it("mixed currencies: rows in another currency block the score; accounts in different currencies are never summed", () => {
    const base = audit({});
    const usdRows = base.input.campaigns.map((campaign, index) => (index === 0 ? { ...campaign, currency: "USD" } : campaign));
    const blocked = audit({ overrides: { campaigns: usdRows } }).result;
    expect(ids(blocked)).toContain("data_quality.currency_mismatch");
    expect(blocked.overallScore).toBeNull();

    const two = audit({
      accounts: [
        { account: metaAccount, campaigns: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] },
        { account: { ...googleAccount, currency: "USD" }, campaigns: [{ id: "g1" }, { id: "g2" }, { id: "g3" }] },
      ],
    }).result;
    expect(two.kpis.totals).toBeNull();
    expect(two.kpis.currency).toBeNull();
    expect(two.summary).not.toContain("Recorded spend");
  });

  it("invalid numbers are recorded as data problems, not silently zero", () => {
    const input = buildAuditInput({
      tenantName: "T", periodStart: START, periodEnd: END,
      accounts: [{ id: META, provider: "meta", account_name: "A", external_account_id: "act_1", currency: "INR" }],
      campaigns: [{ campaign_id: "c1", ad_account_id: META, provider: "meta", account_name: null, external_campaign_id: "1", campaign_name: "c", objective: null, campaign_status: "ACTIVE", channel_type: null, bid_strategy: null, daily_budget: null, currency: "INR", impressions: 10, reach: 0, clicks: 1, spend: "NaN", conversions: "-2", conversion_value: "0", active_days: 1 }],
      daily: [],
    });
    expect(input.inputIssues?.[0]).toMatchObject({ code: "invalid_numeric_value", level: "major" });
    expect(input.campaigns[0].spend).toBe(0);
    expect(input.campaigns[0].conversions).toBe(0);
    const platform = audit({ syncRuns: [syncRun(META, { invalidValues: 3 })] }).result;
    expect(find(platform, "data_quality.invalid_platform_values")?.description).toContain("3 metric value(s)");
  });

  it("validates the period and the account selection", () => {
    expect(() => audit({ overrides: { periodEnd: "2026-10-01" } })).toThrow(/period/);
    expect(() => audit({ overrides: { periodStart: "2025-01-01" } })).toThrow(/366/);
    expect(() => audit({ overrides: { accounts: [metaAccount, metaAccount] } })).toThrow(/more than once/);
    expect(() => audit({ overrides: { accounts: [] } })).toThrow();
  });

  it("converts sync job records into per-account outcomes", () => {
    const accounts: AuditAccount[] = [{ ...metaAccount, connectionId: "c1" }, { ...googleAccount, connectionId: "c2" }];
    const runs = toSyncRuns([
      { id: "j1", connection_id: "c1", job_type: "daily_sync", status: "completed", completed_at: "2026-11-25T00:00:00Z", error_message: null, stats: { window: { since: START, until: END }, account_results: [{ ad_account_id: META, status: "failed", error: "denied", since: START, until: END }] } },
      { id: "j2", connection_id: "c2", job_type: "daily_sync", status: "completed", completed_at: "2026-11-25T00:00:00Z", error_message: null, stats: { window: { since: START, until: END }, failed_accounts: 1 } },
    ], accounts);
    expect(runs).toEqual([
      expect.objectContaining({ adAccountId: META, status: "failed", error: "denied", legacy: false }),
      // A legacy job with any failed account cannot prove success for this account.
      expect.objectContaining({ adAccountId: GOOGLE, status: "failed", legacy: true }),
    ]);
  });

  it("without sync records, coverage is based on rows only and the score is at most provisional", () => {
    const { result } = audit({ noSync: true });
    expect(result.kpis.accounts[0].coverage?.basis).toBe("rows_only");
    expect(result.scoreStatus).toBe("provisional");
  });
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

describe("scoring", () => {
  it("labels scores at every boundary", () => {
    expect([85, 84.9, 70, 69.9, 50, 49.9, 0].map(scoreLabel)).toEqual([
      "Strong", "Healthy with gaps", "Healthy with gaps", "Needs attention", "Needs attention", "At risk", "At risk",
    ]);
  });

  it("weighs findings by severity, basis and spend share", () => {
    expect(penalty({ severity: "critical", basis: "verified" }, null)).toBe(35);
    expect(penalty({ severity: "high", basis: "indicative" }, null)).toBe(10);
    expect(penalty({ severity: "medium", basis: "verified" }, 0)).toBeCloseTo(3.5);
    expect(penalty({ severity: "medium", basis: "verified" }, 0.9)).toBe(10);
    expect(penalty({ severity: "low", basis: "unavailable" }, null)).toBe(0);
    expect(penalty({ severity: "info", basis: "verified" }, null)).toBe(0);
  });

  it("insufficient sample: categories without evidence are not assessed and the account is unscored", () => {
    const { result } = audit({ accounts: [{ account: metaAccount, campaigns: [{ id: "tiny", day: (index) => (index % 3 === 0 ? { impressions: 100, clicks: 3, spend: 30, conversions: 0 } : null) }] }] });
    expect(result.overallScore).toBeNull();
    const categories = result.kpis.scoring!.accounts[0].categories;
    expect(categories.tracking.status).toBe("not_assessed");
    expect(categories.efficiency.status).toBe("not_assessed");
    expect(categories.tracking.reason).toMatch(/fewer than 100 clicks/);
    expect(result.kpis.scoring?.reason).toMatch(/Too few checks/);
  });

  it("does not reward missing data: an unassessed category is excluded, never counted as 100", () => {
    const { result } = audit({});
    const scoring = result.kpis.scoring!.accounts[0];
    const assessed = Object.values(scoring.categories).filter((item) => item.status === "assessed");
    expect(assessed.length).toBeGreaterThan(0);
    for (const [category, item] of Object.entries(scoring.categories)) {
      if (item.status === "not_assessed") expect(result.categoryScores).not.toHaveProperty(category);
    }
    expect(result.categoryScores).not.toHaveProperty("data_quality");
  });

  it("does not double count: the account ROAS finding is superseded by campaign ROAS findings", () => {
    const { result } = audit({ accounts: [{ account: metaAccount, campaigns: [
      { id: "m1", day: () => ({ conversionValue: 200 }) },
      { id: "m2", day: () => ({ conversionValue: 200 }) },
      { id: "m3", day: () => ({ conversionValue: 200 }) },
    ] }] });
    expect(ids(result)).toEqual(expect.arrayContaining(["efficiency.low_roas_campaign", "efficiency.account_roas"]));
    const penalties = result.kpis.scoring!.accounts[0].categories.efficiency.penalties.map((item) => item.ruleId);
    expect(penalties).not.toContain("efficiency.account_roas");
    expect(penalties.filter((ruleId) => ruleId === "efficiency.low_roas_campaign")).toHaveLength(3);
  });

  it("uses supplied business targets and labels them", () => {
    const { result } = audit({ overrides: { targets: [{ adAccountId: META, targetCpa: 50 }] } });
    const finding = find(result, "efficiency.high_cpa_campaign");
    expect(finding?.basis).toBe("target");
    expect(finding?.evidence.reference).toContain("business target CPA");
    expect(finding?.estimateLabel).toContain("estimate");
  });

  it("is deterministic", () => {
    expect(audit({}).result).toEqual(audit({}).result);
  });
});

// ---------------------------------------------------------------------------
// Rules by campaign type
// ---------------------------------------------------------------------------

function googleDiagnostics(sections: AccountDiagnosticsInput["sections"]): AccountDiagnosticsInput[] {
  return [{ adAccountId: GOOGLE, provider: "google", windowStart: START, windowEnd: END, capturedAt: "2026-11-25T11:35:23Z", sections }];
}

describe("zero conversions and conversion value", () => {
  const noConversions = (spec: Partial<CampaignSpec> = {}) => [{ id: "g1", day: () => ({ conversions: 0 }), ...spec }, { id: "g2", day: () => ({ conversions: 0 }), ...spec }];

  it("is critical and verified only when no primary conversion action exists", () => {
    const { result } = audit({
      accounts: [{ account: googleAccount, campaigns: noConversions() }],
      diagnostics: googleDiagnostics({ conversion_actions: { status: "ok", rows: [{ id: "1", name: "Old", status: "ENABLED", primary_for_goal: false }] } }),
    });
    expect(find(result, "tracking.no_conversions")).toMatchObject({ severity: "critical", basis: "verified" });
  });

  it("is high and indicative when primary conversion actions are configured", () => {
    const { result } = audit({
      accounts: [{ account: googleAccount, campaigns: noConversions() }],
      diagnostics: googleDiagnostics({ conversion_actions: { status: "ok", rows: [{ id: "1", name: "Lead form", status: "ENABLED", primary_for_goal: true, category: "SUBMIT_LEAD_FORM", counting_type: "MANY_PER_CLICK" }] } }),
    });
    const finding = find(result, "tracking.no_conversions");
    expect(finding).toMatchObject({ severity: "high", basis: "indicative" });
    expect(finding?.description).toContain("tracking is configured");
    expect(ids(result)).toContain("tracking.lead_counting");
  });

  it("is not raised for awareness campaigns, Meta app campaigns or small samples", () => {
    expect(ids(audit({ accounts: [{ account: googleAccount, campaigns: noConversions({ bidStrategy: "TARGET_CPM", channelType: "VIDEO", objective: "VIDEO" }) }] }).result)).not.toContain("tracking.no_conversions");
    expect(ids(audit({ accounts: [{ account: metaAccount, campaigns: noConversions({ objective: "OUTCOME_APP_PROMOTION" }) }] }).result)).not.toContain("tracking.no_conversions");
    expect(ids(audit({ accounts: [{ account: googleAccount, campaigns: [{ id: "g1", day: (index) => (index === 0 ? { clicks: 50, conversions: 0 } : null) }] }] }).result)).not.toContain("tracking.no_conversions");
  });

  it("Meta: a pixel with no activity in the period makes zero conversions a verified tracking problem", () => {
    const meta = (rows: Array<Record<string, unknown>>) => audit({
      accounts: [{ account: metaAccount, campaigns: noConversions({ objective: "OUTCOME_LEADS" }) }],
      diagnostics: [{ adAccountId: META, provider: "meta", windowStart: START, windowEnd: END, capturedAt: GENERATED, sections: { pixels: { status: "ok", rows } } }],
    }).result;
    expect(find(meta([{ id: "p", last_fired_time: "2026-09-01T00:00:00+0000" }]), "tracking.no_conversions")).toMatchObject({ severity: "critical", basis: "verified" });
    expect(find(meta([{ id: "p", last_fired_time: "2026-11-24T10:00:00+0000" }]), "tracking.no_conversions")).toMatchObject({ severity: "high", basis: "indicative" });
  });

  it("missing conversion value is raised for sales campaigns only", () => {
    const sales = audit({ accounts: [{ account: googleAccount, campaigns: [{ id: "s1", bidStrategy: "TARGET_ROAS" }, { id: "s2", bidStrategy: "TARGET_ROAS" }] }] }).result;
    expect(find(sales, "tracking.no_conversion_value")?.basis).toBe("verified");
    const leads = audit({ accounts: [{ account: metaAccount, campaigns: [{ id: "l1", objective: "OUTCOME_LEADS" }, { id: "l2", objective: "OUTCOME_LEADS" }] }] }).result;
    expect(ids(leads)).not.toContain("tracking.no_conversion_value");
    const app = audit({ accounts: [{ account: googleAccount, campaigns: [{ id: "a1", channelType: "MULTI_CHANNEL", bidStrategy: "TARGET_CPA" }] }] }).result;
    expect(ids(app)).not.toContain("tracking.no_conversion_value");
  });
});

describe("Google campaign types", () => {
  it("Search: search terms, Quality Score and lost impression share use diagnostics evidence", () => {
    const { result } = audit({
      accounts: [{ account: googleAccount, campaigns: [{ id: "s1" }, { id: "s2" }, { id: "s3" }] }],
      diagnostics: googleDiagnostics({
        search_terms: { status: "ok", rows: [
          { search_term: "free cleaning jobs", status: "NONE", clicks: 30, cost: 900, conversions: 0 },
          { search_term: "cleaning course", status: "NONE", clicks: 20, cost: 600, conversions: 0 },
          { search_term: "diy cleaner recipe", status: "NONE", clicks: 15, cost: 500, conversions: 0 },
          { search_term: "office cleaning near me", status: "ADDED", clicks: 200, cost: 6000, conversions: 20 },
        ] },
        keywords: { status: "ok", rows: [
          { text: "cleaning", quality_score: 3, cost: 4000, expected_ctr: "BELOW_AVERAGE", creative_quality: "AVERAGE", landing_page_quality: "AVERAGE" },
          { text: "office cleaning", quality_score: 8, cost: 6000 },
        ] },
        search_impression_share: { status: "ok", rows: [{ campaign_id: "s1", impressions: 60000, search_impression_share: 0.4, search_budget_lost_impression_share: 0.35, search_rank_lost_impression_share: 0.25 }] },
      }),
    });
    expect(find(result, "efficiency.search_terms")).toMatchObject({ basis: "indicative", estimateLabel: "Spend on non-converting search terms (to review)" });
    expect(find(result, "engagement.quality_score")?.description).toContain("expected CTR");
    expect(find(result, "budget.lost_impression_share")?.campaignId).toBe("s1");
    expect(ids(result)).not.toContain("engagement.rank_lost_impression_share"); // 25% < 30% threshold
  });

  it("Performance Max and App: search-term analysis is not applicable", () => {
    const { result } = audit({
      accounts: [{ account: googleAccount, campaigns: [{ id: "p1", channelType: "PERFORMANCE_MAX", objective: "PERFORMANCE_MAX" }, { id: "a1", channelType: "MULTI_CHANNEL", objective: "MULTI_CHANNEL", bidStrategy: "TARGET_CPA" }] }],
      diagnostics: googleDiagnostics({ search_terms: { status: "ok", rows: [{ search_term: "x", clicks: 50, cost: 5000, conversions: 0 }, { search_term: "y", clicks: 50, cost: 5000, conversions: 0 }, { search_term: "z", clicks: 50, cost: 5000, conversions: 0 }] } }),
    });
    expect(ids(result)).not.toContain("efficiency.search_terms");
    const skipped = result.kpis.scoring!.accounts[0].categories.efficiency.skipped;
    expect(skipped).toContainEqual({ ruleId: "efficiency.search_terms", reason: "no Search or Shopping campaigns with delivery" });
    expect(result.kpis.campaigns?.map((item) => item.kind).sort()).toEqual(["app", "pmax"]);
  });

  it("Shopping: low ROAS is measured against reported value and labelled as an estimate", () => {
    const { result } = audit({ accounts: [{ account: googleAccount, campaigns: [
      { id: "sh1", channelType: "SHOPPING", objective: "SHOPPING", day: () => ({ conversionValue: 200 }) },
      { id: "sh2", channelType: "SHOPPING", objective: "SHOPPING", day: () => ({ conversionValue: 1600 }) },
    ] }] });
    const finding = find(result, "efficiency.low_roas_campaign");
    expect(finding?.campaignId).toBe("sh1");
    expect(finding?.estimateLabel).toBe("Spend above reported value (estimate, not a loss)");
    expect(finding?.evidence.unavailable).toContain("product margins");
  });

  it("ad review and ad strength use the captured status", () => {
    const { result } = audit({
      accounts: [{ account: googleAccount, campaigns: [{ id: "s1" }, { id: "s2" }] }],
      diagnostics: googleDiagnostics({ ads: { status: "ok", rows: [
        { campaign_id: "s1", status: "ENABLED", approval_status: "DISAPPROVED", ad_type: "RESPONSIVE_SEARCH_AD", ad_strength: "POOR" },
        { campaign_id: "s1", status: "ENABLED", approval_status: "APPROVED", ad_type: "RESPONSIVE_SEARCH_AD", ad_strength: "POOR" },
        { campaign_id: "s2", status: "ENABLED", approval_status: "APPROVED", ad_type: "RESPONSIVE_SEARCH_AD", ad_strength: "GOOD" },
      ] } }),
    });
    expect(find(result, "engagement.ad_review")).toMatchObject({ campaignId: "s1", severity: "medium", basis: "verified" });
    expect(ids(result)).toContain("engagement.ad_strength");
  });
});

describe("budgets and status", () => {
  it("shared budgets are evaluated on the combined spend of the campaigns that share them", () => {
    const shared: CampaignContext = { start: "2026-01-01", budgetId: "b1", budgetShared: true };
    const healthy = audit({ accounts: [{ account: googleAccount, campaigns: [
      { id: "s1", dailyBudget: 1000, details: shared, day: () => ({ spend: 450 }) },
      { id: "s2", dailyBudget: 1000, details: shared, day: () => ({ spend: 450 }) },
    ] }] }).result;
    expect(ids(healthy)).not.toContain("budget.underspend");
    const under = audit({ accounts: [{ account: googleAccount, campaigns: [
      { id: "s1", dailyBudget: 1000, details: shared, day: () => ({ spend: 150 }) },
      { id: "s2", dailyBudget: 1000, details: shared, day: () => ({ spend: 150 }) },
    ] }] }).result;
    const findings = under.findings.filter((finding) => finding.ruleId === "budget.underspend");
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain("Shared budget used by 2 campaigns");
    expect(findings[0].description).not.toMatch(/limited by bids/);
    expect(findings[0].evidence.unavailable).toContain("budget changes during the period");
  });

  it("status changes: a campaign paused now but delivering in the period is not idle; one that ended earlier is skipped", () => {
    const { result } = audit({ accounts: [{ account: googleAccount, campaigns: [
      { id: "paused-now", status: "PAUSED" },
      { id: "ended", status: "ENABLED", details: { start: "2026-01-01", end: "2026-10-01 23:59:59" }, day: () => null },
      { id: "live" },
    ] }] });
    expect(ids(result)).not.toContain("structure.no_delivery");
  });
});

describe("Meta", () => {
  it("learning-limited findings come from ad set learning status with the optimization goal", () => {
    const { result } = audit({
      diagnostics: [{ adAccountId: META, provider: "meta", windowStart: START, windowEnd: END, capturedAt: GENERATED, sections: { ad_sets: { status: "ok", rows: [
        { campaign_id: "m1", effective_status: "ACTIVE", learning_status: "FAIL", optimization_goal: "OFFSITE_CONVERSIONS" },
        { campaign_id: "m1", effective_status: "ACTIVE", learning_status: "SUCCESS", optimization_goal: "OFFSITE_CONVERSIONS" },
      ] } } }],
    });
    const finding = find(result, "structure.learning_limited");
    expect(finding).toMatchObject({ campaignId: "m1", basis: "verified", severity: "low" });
    expect(finding?.evidence.observed.optimization_goals).toBe("OFFSITE_CONVERSIONS");
  });

  it("does not infer learning status from conversion counts when it was not captured", () => {
    const { result } = audit({});
    expect(ids(result)).not.toContain("structure.learning_limited");
    expect(result.kpis.scoring!.accounts[0].categories.structure.reason).not.toContain("structure.learning_limited");
  });

  it("frequency uses daily reach and is skipped when Meta did not return reach", () => {
    const fatigued = audit({ accounts: [{ account: metaAccount, campaigns: [{ id: "m1", day: () => ({ impressions: 6000, reach: 1500 }) }, { id: "m2" }, { id: "m3" }] }] }).result;
    expect(find(fatigued, "engagement.high_frequency")?.evidence.unavailable).toContain("unique reach for the whole period");
    const noReach = audit({
      accounts: [{ account: metaAccount, campaigns: [{ id: "m1", day: () => ({ impressions: 6000, reach: 1500 }) }, { id: "m2" }, { id: "m3" }] }],
      syncRuns: [syncRun(META, { unavailableFields: ["reach"] })],
    }).result;
    expect(ids(noReach)).not.toContain("engagement.high_frequency");
    expect(ids(noReach)).toContain("data_quality.fields_unavailable");
  });

  it("CTR comparisons use same-type peers by default and label sourced benchmarks", () => {
    const peers = audit({ accounts: [{ account: metaAccount, campaigns: [{ id: "m1", day: () => ({ clicks: 4 }) }, { id: "m2" }, { id: "m3" }] }] }).result;
    expect(find(peers, "engagement.low_ctr")).toMatchObject({ campaignId: "m1", basis: "indicative" });
    const sourced = audit({ overrides: { benchmarks: [{ metric: "ctr", provider: "meta", kind: "meta", value: 0.05, source: "Example 2026 study", applicability: "Meta feed, India" }] } }).result;
    expect(find(sourced, "engagement.low_ctr")).toMatchObject({ basis: "benchmark" });
  });
});

describe("trends", () => {
  it("compares equal halves of known days only", () => {
    const rising = audit({ accounts: [{ account: metaAccount, campaigns: ["m1", "m2", "m3"].map((id) => ({ id, day: (index: number) => ({ conversions: index < 15 ? 4 : 2, conversionValue: 1600 }) })) }] }).result;
    expect(find(rising, "trend.cpa_rising")?.evidence.observed).toMatchObject({ cpa_first_half: 100, cpa_second_half: 200 });
    // A half with missing days is not compared.
    const gap = audit({
      syncRuns: [syncRun(META, { since: "2026-11-05", until: END })],
      accounts: [{ account: metaAccount, campaigns: ["m1", "m2", "m3"].map((id) => ({ id, day: (index: number) => (index < 10 ? null : { conversions: index < 15 ? 4 : 2 }) })) }],
    }).result;
    expect(ids(gap)).not.toContain("trend.cpa_rising");
  });

  it("spend volatility ignores missing days and zero-delivery days", () => {
    const { result } = audit({ accounts: [{ account: metaAccount, campaigns: ["m1", "m2", "m3"].map((id) => ({ id, day: (index: number) => (index % 2 === 0 ? null : {}) })) }] });
    expect(ids(result)).not.toContain("trend.spend_volatility"); // 15 identical delivery days, 15 zero days
    expect(result.kpis.accounts[0].coverage?.zeroDeliveryDays).toBe(15);
  });
});

describe("multiple accounts and providers", () => {
  it("scores accounts separately, keeps platform scores apart and averages scored accounts", () => {
    const { result } = audit({
      accounts: [
        { account: metaAccount, campaigns: [{ id: "m1", day: () => ({ conversionValue: 1600 }) }, { id: "m2", day: () => ({ conversionValue: 1600 }) }, { id: "m3", day: () => ({ conversionValue: 1600 }) }] },
        { account: googleAccount, campaigns: [{ id: "g1" }, { id: "g2" }, { id: "g3" }] },
      ],
    });
    const scores = result.kpis.accounts.map((item) => item.score as number);
    expect(result.overallScore).toBeCloseTo((scores[0] + scores[1]) / 2, 0);
    expect(result.platformScores.meta).toBe(scores[0]);
    expect(result.platformScores.google).toBe(scores[1]);
    expect(result.kpis.dataQuality?.accounts).toHaveLength(2);
    for (const finding of result.findings) {
      if (finding.adAccountId) expect([META, GOOGLE]).toContain(finding.adAccountId);
    }
  });

  it("every finding carries observed values, thresholds, the period and unavailable data", () => {
    const { result } = audit({ accounts: [{ account: googleAccount, campaigns: [{ id: "g1", day: () => ({ conversions: 0 }) }, { id: "g2", day: () => ({ conversions: 0 }) }] }] });
    expect(result.findings.length).toBeGreaterThan(0);
    for (const finding of result.findings) {
      expect(finding.evidence.period).toEqual({ start: START, end: END, days: 30 });
      expect(finding.evidence).toHaveProperty("observed");
      expect(finding.evidence).toHaveProperty("thresholds");
      expect(Array.isArray(finding.evidence.unavailable)).toBe(true);
      expect(["verified", "indicative", "benchmark", "target", "unavailable"]).toContain(finding.basis);
      if (finding.estimatedImpact !== null) expect(finding.estimateLabel).toBeTruthy();
    }
  });
});
