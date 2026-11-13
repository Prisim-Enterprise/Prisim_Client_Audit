// @vitest-environment node
import { base64UrlEncode, pkceChallenge, pkceVerifier, signState, verifyState, type OAuthStatePayload } from "@functions/_shared/oauth-state.ts";
import { buildAuditReportPdf, type ReportData } from "@functions/_shared/report/pdf.ts";
import { toReportData } from "@functions/_shared/report/data.ts";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

const SECRET = "test-secret-that-is-at-least-32-characters-long";

function reportData(overrides: Partial<ReportData> = {}): ReportData {
  return {
    tenantName: "Test Clinic – ₹ “Quotes”",
    title: "Q4 audit",
    periodStart: "2026-10-01",
    periodEnd: "2026-10-30",
    generatedAt: "2026-11-01T10:00:00.000Z",
    published: true,
    overallScore: 72.4,
    platformScores: { meta: 70, google: 81 },
    categoryScores: { tracking: 100, efficiency: 64, engagement: 82, structure: 91, budget: 96, trend: 100, data_quality: 100 },
    summary: "A long summary. ".repeat(40),
    accounts: [{ name: "Meta account", provider: "meta", currency: "INR", spend: 120000, impressions: 900000, clicks: 12000, conversions: 340, conversionValue: 0 }],
    findings: Array.from({ length: 14 }, (_, index) => ({
      severity: (["critical", "high", "medium", "low", "info"] as const)[index % 5],
      category: "efficiency",
      platform: "meta",
      title: `Finding ${index + 1} with a reasonably long title that wraps across the page width`,
      description: "Description ".repeat(30),
      recommendation: "Recommendation ".repeat(25),
      reviewerNote: index % 3 === 0 ? "Reviewed by PRISIM" : null,
      status: index === 4 ? "dismissed" : "open",
      estimatedImpact: index % 2 === 0 ? 5000 : null,
      impactCurrency: "INR",
    })),
    campaigns: Array.from({ length: 40 }, (_, index) => ({
      name: `Campaign ${index}`,
      provider: index % 2 ? "google" : "meta",
      currency: "INR",
      spend: 1000 * (index + 1),
      impressions: 10000,
      clicks: 200,
      conversions: 5,
      conversionValue: index % 2 ? 0 : 9000,
    })),
    engineVersion: "prisim-audit-1.0.0",
    ...overrides,
  };
}

describe("PDF report", () => {
  it("renders a multi-page PDF that handles non-ASCII text", async () => {
    const bytes = await buildAuditReportPdf(reportData());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(5);
    expect(doc.getTitle()).toContain("Test Clinic");
    expect(bytes.byteLength).toBeLessThan(20 * 1024 * 1024);
  });

  it("marks synthetic demo reports in the metadata", async () => {
    const doc = await PDFDocument.load(await buildAuditReportPdf(reportData({ synthetic: true, published: false })));
    expect(doc.getSubject()).toMatch(/synthetic/i);
  });

  it("renders an audit with no findings, accounts or score", async () => {
    const bytes = await buildAuditReportPdf(reportData({ findings: [], campaigns: [], accounts: [], overallScore: null, platformScores: {}, summary: null }));
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(4);
  });

  it("maps database rows to report data", () => {
    const data = toReportData({
      tenantName: "T",
      run: {
        id: "r",
        title: "Audit",
        period_start: "2026-10-01",
        period_end: "2026-10-30",
        status: "in_review",
        engine_version: "v",
        overall_score: "64.5",
        platform_scores: { meta: "60" },
        category_scores: { tracking: 80 },
        kpis: { accounts: [{ name: "A", provider: "meta", currency: "INR", spend: 10, impressions: 1, clicks: 1, conversions: 1, conversionValue: 0 }] },
        summary: null,
      },
      findings: [
        { severity: "low", category: "budget", platform: null, title: "b", description: "", recommendation: "", reviewer_note: null, status: "open", estimated_impact: null, impact_currency: null, sort_order: 2 },
        { severity: "high", category: "budget", platform: null, title: "a", description: "", recommendation: "", reviewer_note: null, status: "open", estimated_impact: "12.5", impact_currency: "INR", sort_order: 1 },
      ],
      campaigns: [],
    });
    expect(data.published).toBe(false);
    expect(data.overallScore).toBe(64.5);
    expect(data.platformScores.meta).toBe(60);
    expect(data.findings.map((finding) => finding.title)).toEqual(["a", "b"]);
    expect(data.findings[0].estimatedImpact).toBe(12.5);
  });
});

describe("OAuth state", () => {
  const payload: OAuthStatePayload = {
    v: 1,
    a: "a1000000-0000-4000-8000-000000000001",
    c: "c1000000-0000-4000-8000-000000000001",
    t: "d1000000-0000-4000-8000-000000000001",
    p: "google",
    u: "e1000000-0000-4000-8000-000000000001",
    n: "nonce-value-1234567890",
    e: 2_000_000_000,
  };

  it("round-trips a signed state", async () => {
    const state = await signState(payload, SECRET);
    expect(await verifyState(state, SECRET, 1_900_000_000)).toEqual(payload);
  });

  it("rejects tampering, wrong secrets, expiry and malformed values", async () => {
    const state = await signState(payload, SECRET);
    const [body, signature] = state.split(".");
    const forged = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ ...payload, t: "d2000000-0000-4000-8000-000000000002" })));
    expect(await verifyState(`${forged}.${signature}`, SECRET, 1_900_000_000)).toBeNull();
    expect(await verifyState(state, `${SECRET}x`, 1_900_000_000)).toBeNull();
    expect(await verifyState(state, SECRET, 2_100_000_000)).toBeNull();
    expect(await verifyState(`${body}`, SECRET)).toBeNull();
    expect(await verifyState("a.b.c", SECRET)).toBeNull();
    await expect(signState(payload, "short")).rejects.toThrow();
  });

  it("derives a stable RFC 7636 PKCE pair", async () => {
    const verifier = await pkceVerifier(SECRET, payload.n);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await pkceVerifier(SECRET, payload.n)).toBe(verifier);
    // RFC 7636 appendix B test vector
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});
