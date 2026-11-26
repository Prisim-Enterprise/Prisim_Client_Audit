// @vitest-environment node
// A verified critical or high finding must stay visible - with its evidence
// and recommended action - when the account is Not scored, and Not scored must
// never read as "healthy" (engine, saved payload, report data and PDF).
import { runAudit } from "@functions/_shared/audit/engine.ts";
import { toSaveAuditPayload } from "@functions/_shared/audit/payload.ts";
import type { AccountDiagnosticsInput, AuditAccount, AuditCampaign, AuditDailyRow, AuditInput, SyncRunRecord } from "@functions/_shared/audit/types.ts";
import { addDays } from "@functions/_shared/format.ts";
import { toReportData } from "@functions/_shared/report/data.ts";
import { buildAuditReportPdf } from "@functions/_shared/report/pdf.ts";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

const START = "2026-10-26";
const END = "2026-11-24";
const GOOGLE = "a0000000-0000-4000-8000-000000000002";
const account: AuditAccount = { id: GOOGLE, provider: "google", name: "Google", currency: "INR" };

function run(overrides: Partial<SyncRunRecord> = {}): SyncRunRecord {
  return { adAccountId: GOOGLE, connectionId: "c", jobType: "manual_sync", status: "succeeded", completedAt: "2026-11-25T11:00:00Z", since: "2026-08-27", until: END, invalidValues: 0, unavailableFields: [], error: null, legacy: false, zeroDaysVerified: true, reconciliation: "matched", ...overrides };
}

/** Two Search campaigns delivering on the given day indexes, no conversions. */
function search(dayIndexes: number[]): { campaigns: AuditCampaign[]; daily: AuditDailyRow[] } {
  const perDay = { impressions: 2000, clicks: 100, spend: 500 };
  const campaigns = ["s1", "s2"].map((id): AuditCampaign => ({
    id, adAccountId: GOOGLE, provider: "google", name: id, objective: "SEARCH", status: "ENABLED", channelType: "SEARCH", bidStrategy: "TARGET_CPA", dailyBudget: null,
    impressions: perDay.impressions * dayIndexes.length, reach: 0, clicks: perDay.clicks * dayIndexes.length, spend: perDay.spend * dayIndexes.length,
    conversions: 0, conversionValue: 0, activeDays: dayIndexes.length, externalId: id, details: { start: "2026-01-01", capturedAt: "2026-11-25T11:00:00Z" },
  }));
  const daily = dayIndexes.map((index): AuditDailyRow => ({ date: addDays(START, index), adAccountId: GOOGLE, impressions: 4000, reach: 0, clicks: 200, spend: 1000, conversions: 0, conversionValue: 0 }));
  return { campaigns, daily };
}

function input(overrides: Partial<AuditInput>): AuditInput {
  return { tenantName: "T", periodStart: START, periodEnd: END, accounts: [account], campaigns: [], daily: [], generatedAt: "2026-11-26T09:00:00Z", ...overrides };
}

const noPrimaryAction: AccountDiagnosticsInput[] = [{
  adAccountId: GOOGLE, provider: "google", windowStart: START, windowEnd: END, capturedAt: "2026-11-25T11:00:00Z",
  sections: { conversion_actions: { status: "ok", rows: [{ id: "1", name: "Old lead", status: "ENABLED", primary_for_goal: false }] } },
}];

async function report(result: ReturnType<typeof runAudit>) {
  const payload = toSaveAuditPayload(result, { title: "Audit", periodStart: START, periodEnd: END, adAccountIds: [GOOGLE] });
  const data = toReportData({
    tenantName: "T",
    run: { id: "r", title: "Audit", period_start: START, period_end: END, status: "published", engine_version: payload.run.engine_version, overall_score: payload.run.overall_score, platform_scores: payload.run.platform_scores, category_scores: payload.run.category_scores, kpis: payload.run.kpis as never, summary: payload.run.summary },
    findings: payload.findings.map((finding, index) => ({ ...finding, severity: finding.severity as "critical", reviewer_note: null, status: "open", sort_order: index })),
    campaigns: [],
  });
  const pdf = await PDFDocument.load(await buildAuditReportPdf(data));
  return { payload, data, pages: pdf.getPageCount() };
}

describe("critical findings on Not scored audits", () => {
  it("a verified critical finding stays visible, with evidence and action, when there is too little evidence for a score", async () => {
    const { campaigns, daily } = search(Array.from({ length: 30 }, (_, index) => index));
    const result = runAudit(input({ campaigns, daily, syncRuns: [run()], diagnostics: noPrimaryAction }));

    // Score: not enough assessable areas -> Not scored.
    expect(result.overallScore).toBeNull();
    expect(result.kpis.scoring?.platforms.google?.status).toBe("unscored");
    expect(result.kpis.scoring?.platforms.google?.reason).toMatch(/Too few checks/);

    // Finding: still there, verified, with evidence and a recommendation.
    const critical = result.findings.find((finding) => finding.ruleId === "tracking.no_conversions");
    expect(critical).toMatchObject({ severity: "critical", basis: "verified" });
    expect(result.findings[0]).toBe(critical); // sorted first
    expect(critical?.recommendation).toMatch(/Goals > Conversions/);
    expect(critical?.evidence.observed).toMatchObject({ primary_conversion_actions: 0, conversions: 0, spend: 30000 });
    expect(critical?.evidence.period).toEqual({ start: START, end: END, days: 30 });
    expect(critical?.evidence.source).toMatch(/diagnostics/);

    // The summary says Not scored is not healthy.
    expect(result.kpis.findingCounts).toMatchObject({ critical: 1 });
    expect(result.summary).toContain("Google Ads: no score was calculated");
    expect(result.summary).toContain("Not scored does not mean the account is healthy: 1 critical or high-priority finding needs action");
    expect(result.summary).not.toMatch(/No critical or high-priority/);

    // Saved payload, report data and PDF keep the finding and its evidence.
    const { payload, data, pages } = await report(result);
    expect(payload.run.overall_score).toBeNull();
    expect(payload.findings[0]).toMatchObject({ rule_id: "tracking.no_conversions", severity: "critical", evidence: expect.objectContaining({ basis: "verified" }) });
    expect(data.findings[0]).toMatchObject({ severity: "critical", basis: "verified" });
    expect(data.findings[0].evidence?.some((line) => line.startsWith("Observed:"))).toBe(true);
    expect(data.findings[0].recommendation).toMatch(/Goals > Conversions/);
    expect(data.scoreStatus).toBe("unscored");
    expect(pages).toBeGreaterThanOrEqual(4);
  });

  it("a verified high finding stays visible when the score is blocked by missing data", async () => {
    // Only 12 of 30 days were retrieved (blocking: > 50% missing).
    const days = Array.from({ length: 12 }, (_, index) => 18 + index);
    const { campaigns, daily } = search(days);
    const diagnostics: AccountDiagnosticsInput[] = [{
      adAccountId: GOOGLE, provider: "google", windowStart: START, windowEnd: END, capturedAt: "2026-11-25T11:00:00Z",
      sections: { ads: { status: "ok", rows: [
        { campaign_id: "s1", status: "ENABLED", approval_status: "DISAPPROVED", ad_type: "RESPONSIVE_SEARCH_AD" },
        { campaign_id: "s1", status: "ENABLED", approval_status: "DISAPPROVED", ad_type: "RESPONSIVE_SEARCH_AD" },
      ] } },
    }];
    const result = runAudit(input({ campaigns, daily, syncRuns: [run({ since: addDays(START, 18), until: END })], diagnostics }));
    expect(result.overallScore).toBeNull();
    expect(result.kpis.scoring?.platforms.google?.reason).toMatch(/Blocking data problem/);
    const high = result.findings.find((finding) => finding.ruleId === "engagement.ad_review");
    expect(high).toMatchObject({ severity: "high", basis: "verified", campaignId: "s1" });
    expect(high?.recommendation).toMatch(/policy details/);
    expect(result.findings.map((finding) => finding.ruleId)).toContain("data_quality.missing_days");
    expect(result.summary).toContain("Not scored does not mean the account is healthy");
    const { data } = await report(result);
    expect(data.findings.find((finding) => finding.title.includes("disapproved"))).toMatchObject({ severity: "high", basis: "verified" });
  });

  it("an unscored account without urgent findings does not claim problems, and still does not call itself healthy", () => {
    const result = runAudit(input({ campaigns: [], daily: [], syncRuns: [] }));
    expect(result.overallScore).toBeNull();
    expect(result.kpis.findingCounts).toMatchObject({ critical: 0, high: 0 });
    expect(result.summary).not.toMatch(/healthy|strong/i);
    expect(result.summary).toContain("no score was calculated");
  });
});
