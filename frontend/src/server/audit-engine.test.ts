// @vitest-environment node
import { ctrBenchmark, deriveKpis, runAudit, scoreFindings, sortFindings } from "@functions/_shared/audit/engine.ts";
import { buildAuditInput, num } from "@functions/_shared/audit/input.ts";
import { toSaveAuditPayload } from "@functions/_shared/audit/payload.ts";
import type { AuditCampaign, AuditDailyRow, AuditInput } from "@functions/_shared/audit/types.ts";
import { addDays, daysBetweenInclusive, formatMoney, toPdfSafeText } from "@functions/_shared/format.ts";
import { describe, expect, it } from "vitest";

const META = "a0000000-0000-4000-8000-000000000001";
const GOOGLE = "a0000000-0000-4000-8000-000000000002";

function campaign(overrides: Partial<AuditCampaign> & { id: string; adAccountId: string }): AuditCampaign {
  return {
    provider: overrides.adAccountId === GOOGLE ? "google" : "meta",
    name: overrides.id,
    objective: "OUTCOME_LEADS",
    status: "ACTIVE",
    channelType: null,
    bidStrategy: null,
    dailyBudget: null,
    impressions: 100_000,
    reach: 60_000,
    clicks: 1_500,
    spend: 30_000,
    conversions: 100,
    conversionValue: 0,
    activeDays: 30,
    ...overrides,
  };
}

function daily(adAccountId: string, days: number, perDay: (index: number) => Partial<AuditDailyRow>): AuditDailyRow[] {
  return Array.from({ length: days }, (_, index) => ({
    date: addDays("2026-10-01", index),
    adAccountId,
    impressions: 3000,
    reach: 2000,
    clicks: 50,
    spend: 1000,
    conversions: 4,
    conversionValue: 0,
    ...perDay(index),
  }));
}

function input(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    tenantName: "Test Co",
    periodStart: "2026-10-01",
    periodEnd: "2026-10-30",
    accounts: [{ id: META, provider: "meta", name: "Meta account", currency: "INR" }],
    campaigns: [campaign({ id: "healthy", adAccountId: META })],
    daily: daily(META, 30, () => ({})),
    ...overrides,
  };
}

const ruleIds = (result: ReturnType<typeof runAudit>) => result.findings.map((finding) => finding.ruleId);

describe("audit engine", () => {
  it("scores a healthy account highly with no urgent findings", () => {
    const result = runAudit(input());
    expect(result.overallScore).toBeGreaterThanOrEqual(90);
    expect(result.findings.filter((finding) => ["critical", "high"].includes(finding.severity))).toHaveLength(0);
    expect(result.kpis.totals?.cpa).toBeCloseTo(300);
    expect(result.platformScores.meta).toBeDefined();
    expect(result.platformScores.google).toBeUndefined();
  });

  it("flags missing conversion tracking as critical with spend at risk", () => {
    const result = runAudit(input({
      campaigns: [campaign({ id: "no-conv", adAccountId: META, conversions: 0 })],
      daily: daily(META, 30, () => ({ conversions: 0 })),
    }));
    const finding = result.findings.find((item) => item.ruleId === "tracking.no_conversions");
    expect(finding?.severity).toBe("critical");
    expect(finding?.estimatedImpact).toBe(30000);
    expect(finding?.impactCurrency).toBe("INR");
    expect(result.findings[0].ruleId).toBe("tracking.no_conversions");
    expect(result.categoryScores.tracking).toBeLessThan(70);
  });

  it("detects wasted spend, CPA outliers, low ROAS, fatigue and low CTR", () => {
    const result = runAudit(input({
      campaigns: [
        campaign({ id: "winner", adAccountId: META, spend: 40_000, conversions: 200, conversionValue: 200_000 }),
        campaign({ id: "waste", adAccountId: META, spend: 10_000, conversions: 0, clicks: 400 }),
        campaign({ id: "expensive", adAccountId: META, spend: 12_000, conversions: 8, conversionValue: 6_000 }),
        campaign({ id: "fatigued", adAccountId: META, impressions: 90_000, reach: 15_000, spend: 5_000, conversions: 20, conversionValue: 30_000 }),
        campaign({ id: "dull", adAccountId: META, impressions: 80_000, clicks: 200, spend: 4_000, conversions: 10, conversionValue: 20_000 }),
      ],
    }));
    const ids = ruleIds(result);
    expect(ids).toContain("efficiency.spend_without_conversions");
    expect(ids).toContain("efficiency.high_cpa_campaign");
    expect(ids).toContain("efficiency.low_roas_campaign");
    expect(ids).toContain("engagement.high_frequency");
    expect(ids).toContain("engagement.low_ctr");
    const waste = result.findings.find((finding) => finding.ruleId === "efficiency.spend_without_conversions");
    expect(waste?.campaignId).toBe("waste");
  });

  it("applies Google-specific rules and channel CTR benchmarks", () => {
    expect(ctrBenchmark("google", "SEARCH")).toBeGreaterThan(ctrBenchmark("google", "DISPLAY"));
    const result = runAudit(input({
      accounts: [{ id: GOOGLE, provider: "google", name: "Google account", currency: "INR" }],
      campaigns: [
        campaign({ id: "search", adAccountId: GOOGLE, objective: "SEARCH", channelType: "SEARCH", bidStrategy: "MANUAL_CPC", impressions: 20_000, clicks: 1_400, conversions: 60 }),
        campaign({ id: "pmax", adAccountId: GOOGLE, objective: "PERFORMANCE_MAX", status: "ENABLED", channelType: "PERFORMANCE_MAX", dailyBudget: 5000, spend: 30_000, impressions: 100_000, clicks: 900, conversions: 40 }),
      ],
      daily: daily(GOOGLE, 30, () => ({})),
    }));
    const ids = ruleIds(result);
    expect(ids).toContain("structure.manual_bidding");
    expect(ids).toContain("budget.underspend");
    expect(ids).not.toContain("engagement.high_frequency");
  });

  it("detects a rising CPA trend from daily rows", () => {
    const result = runAudit(input({
      daily: daily(META, 30, (index) => ({ conversions: index < 15 ? 6 : 3 })),
    }));
    expect(ruleIds(result)).toContain("trend.cpa_rising");
  });

  it("reports missing data days and idle campaigns", () => {
    const result = runAudit(input({
      campaigns: [campaign({ id: "live", adAccountId: META }), campaign({ id: "idle", adAccountId: META, impressions: 0, clicks: 0, spend: 0, conversions: 0, reach: 0 })],
      daily: daily(META, 10, () => ({})),
    }));
    const ids = ruleIds(result);
    expect(ids).toContain("data_quality.missing_days");
    expect(ids).toContain("structure.idle_campaigns");
  });

  it("never sums money across currencies", () => {
    const result = runAudit(input({
      accounts: [
        { id: META, provider: "meta", name: "Meta INR", currency: "INR" },
        { id: GOOGLE, provider: "google", name: "Google USD", currency: "USD" },
      ],
      campaigns: [campaign({ id: "a", adAccountId: META }), campaign({ id: "b", adAccountId: GOOGLE, channelType: "SEARCH" })],
      daily: [...daily(META, 30, () => ({})), ...daily(GOOGLE, 30, () => ({}))],
    }));
    expect(result.kpis.currency).toBeNull();
    expect(result.kpis.totals).toBeNull();
    expect(result.kpis.accounts).toHaveLength(2);
    expect(result.summary).not.toContain("Total spend");
  });

  it("is deterministic and bounded", () => {
    const a = runAudit(input());
    const b = runAudit(input());
    expect(a).toEqual(b);
    const worst = scoreFindings(
      Array.from({ length: 30 }, () => ({
        finding: { ...a.findings[0], severity: "critical" as const, category: "tracking" as const },
        spendShare: null,
      })),
    );
    expect(worst.categories.tracking).toBe(0);
    expect(worst.overall).toBeGreaterThanOrEqual(0);
  });

  it("rejects invalid input", () => {
    expect(() => runAudit(input({ periodEnd: "2026-09-01" }))).toThrow();
    expect(() => runAudit(input({ accounts: [] }))).toThrow();
  });

  it("orders findings by severity then impact", () => {
    const sorted = sortFindings([
      { severity: "low", estimatedImpact: 900, title: "b" },
      { severity: "critical", estimatedImpact: 1, title: "a" },
      { severity: "high", estimatedImpact: 50, title: "c" },
      { severity: "high", estimatedImpact: 500, title: "d" },
    ]);
    expect(sorted.map((item) => item.title)).toEqual(["a", "d", "c", "b"]);
  });
});

describe("audit input and payload", () => {
  it("normalizes PostgREST numeric strings and filters to selected accounts", () => {
    const built = buildAuditInput({
      tenantName: "T",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-30",
      accounts: [{ id: META, provider: "meta", account_name: null, external_account_id: "act_1", currency: "INR" }],
      campaigns: [
        { campaign_id: "c1", ad_account_id: META, provider: "meta", account_name: null, external_campaign_id: "1", campaign_name: null, objective: null, campaign_status: null, channel_type: null, bid_strategy: null, daily_budget: "12.50", currency: "INR", impressions: 10, reach: 5, clicks: 2, spend: "3.25", conversions: "1", conversion_value: "0", active_days: 1 },
        { campaign_id: "c2", ad_account_id: GOOGLE, provider: "google", account_name: null, external_campaign_id: "2", campaign_name: "x", objective: null, campaign_status: null, channel_type: null, bid_strategy: null, daily_budget: null, currency: "USD", impressions: 1, reach: 0, clicks: 0, spend: 1, conversions: 0, conversion_value: 0, active_days: 1 },
      ],
      daily: [],
    });
    expect(built.accounts[0].name).toBe("act_1");
    expect(built.campaigns).toHaveLength(1);
    expect(built.campaigns[0].spend).toBe(3.25);
    expect(built.campaigns[0].dailyBudget).toBe(12.5);
    expect(built.campaigns[0].name).toBe("Campaign 1");
    expect(num("abc")).toBe(0);
  });

  it("serializes results within database limits", () => {
    const result = runAudit(input({ campaigns: [campaign({ id: "no-conv", adAccountId: META, conversions: 0 })], daily: daily(META, 30, () => ({ conversions: 0 })) }));
    const payload = toSaveAuditPayload(result, { title: "x".repeat(300), periodStart: "2026-10-01", periodEnd: "2026-10-30", adAccountIds: [META] });
    expect(payload.run.title.length).toBeLessThanOrEqual(200);
    expect(payload.findings[0]).toMatchObject({ rule_id: "tracking.no_conversions", ad_account_id: META, severity: "critical" });
    for (const finding of payload.findings) expect(finding.rule_id).toMatch(/^[a-z0-9_.]{2,80}$/);
  });
});

describe("formatting", () => {
  it("formats money without non-ASCII symbols and counts days", () => {
    expect(formatMoney(1234567.891, "INR", 2)).toBe("INR 12,34,567.89");
    expect(formatMoney(1234.5, "USD", 0)).toBe("USD 1,235");
    expect(formatMoney(null, "USD")).toBe("-");
    expect(daysBetweenInclusive("2026-10-01", "2026-10-30")).toBe(30);
    expect(toPdfSafeText("₹100 – “quoted” …")).toBe("INR 100 - \"quoted\" ...");
    expect(deriveKpis({ impressions: 0, reach: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0 }).ctr).toBeNull();
  });
});
