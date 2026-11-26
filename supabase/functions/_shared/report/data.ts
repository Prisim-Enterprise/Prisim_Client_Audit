// Builds ReportData from database rows (audit_runs, audit_findings and
// get_campaign_performance). Shared by generate-report and demo mode.

import { type CampaignPerformanceRow, num } from "../audit/input.ts";
import type { ReportData, ReportFinding } from "./pdf.ts";

export type AuditRunRow = {
  id: string;
  title: string;
  period_start: string;
  period_end: string;
  status: string;
  engine_version: string;
  overall_score: number | string | null;
  platform_scores: Record<string, number | string>;
  category_scores: Record<string, number | string>;
  kpis: { accounts?: Array<Record<string, unknown>> } & Record<string, unknown>;
  summary: string | null;
};

export type AuditFindingRow = {
  severity: ReportFinding["severity"];
  category: string;
  platform: string | null;
  title: string;
  description: string;
  recommendation: string;
  reviewer_note: string | null;
  status: string;
  estimated_impact: number | string | null;
  impact_currency: string | null;
  sort_order: number;
  evidence?: Record<string, unknown> | null;
};

function scalar(value: unknown) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

/** Engine 2.0 evidence -> short lines for the PDF; engine 1.0 evidence -> one line. */
export function evidenceLines(evidence: Record<string, unknown> | null | undefined): string[] {
  if (!evidence || typeof evidence !== "object") return [];
  const observed = evidence.observed as Record<string, unknown> | undefined;
  if (!observed || typeof observed !== "object") {
    const flat = Object.entries(evidence).slice(0, 4).map(([key, value]) => `${key.replace(/_/g, " ")}: ${scalar(value)}`);
    return flat.length > 0 ? [`Evidence: ${flat.join("; ")}`] : [];
  }
  const lines: string[] = [];
  const values = Object.entries(observed).filter(([, value]) => value !== null).slice(0, 8).map(([key, value]) => `${key.replace(/_/g, " ")} ${scalar(value)}`);
  if (values.length > 0) lines.push(`Observed: ${values.join("; ")}`);
  const thresholds = Object.entries((evidence.thresholds ?? {}) as Record<string, unknown>).map(([key, value]) => `${key.replace(/_/g, " ")} ${scalar(value)}`);
  if (thresholds.length > 0) lines.push(`Threshold: ${thresholds.join("; ")}`);
  const period = evidence.period as { start?: string; end?: string } | undefined;
  const source = typeof evidence.source === "string" ? evidence.source : null;
  if (period?.start || source) lines.push(`${period?.start ? `Period ${period.start} to ${period.end}. ` : ""}${source ? `Source: ${source}.` : ""}`);
  if (typeof evidence.reference === "string") lines.push(`Reference: ${evidence.reference}`);
  const unavailable = Array.isArray(evidence.unavailable) ? evidence.unavailable.filter((item): item is string => typeof item === "string") : [];
  if (unavailable.length > 0) lines.push(`Not available: ${unavailable.join("; ")}`);
  return lines;
}

function scoreStatus(run: AuditRunRow): "scored" | "provisional" | "unscored" {
  const status = run.kpis.score_status;
  if (status === "scored" || status === "provisional" || status === "unscored") return status;
  return run.overall_score === null ? "unscored" : "scored";
}

function platformScoring(scoring: Record<string, unknown> | null) {
  const platforms = (scoring?.platforms ?? null) as Record<string, Record<string, unknown>> | null;
  if (!platforms) return undefined;
  return (["google", "meta"] as const).flatMap((provider) => {
    const item = platforms[provider];
    if (!item) return [];
    const status = item.status === "provisional" || item.status === "unscored" ? item.status : "scored";
    return [{ provider, score: typeof item.score === "number" ? item.score : null, status: status as "scored" | "provisional" | "unscored", reason: typeof item.reason === "string" ? item.reason : null }];
  });
}

function numberRecord(value: Record<string, number | string> | null | undefined): Record<string, number> {
  return Object.fromEntries(Object.entries(value ?? {}).map(([key, item]) => [key, num(item)]));
}

export function toReportData(options: {
  tenantName: string;
  run: AuditRunRow;
  findings: AuditFindingRow[];
  campaigns: CampaignPerformanceRow[];
  generatedAt?: string;
  synthetic?: boolean;
}): ReportData {
  const { run } = options;
  const quality = (run.kpis.dataQuality ?? null) as Record<string, unknown> | null;
  const scoring = (run.kpis.scoring ?? null) as Record<string, unknown> | null;
  const accounts = (run.kpis.accounts ?? []).map((account) => ({
    name: String(account.name ?? "Ad account"),
    provider: String(account.provider ?? ""),
    currency: typeof account.currency === "string" ? account.currency : null,
    spend: num(account.spend as number),
    impressions: num(account.impressions as number),
    clicks: num(account.clicks as number),
    conversions: num(account.conversions as number),
    conversionValue: num(account.conversionValue as number),
  }));
  return {
    tenantName: options.tenantName,
    title: run.title,
    periodStart: run.period_start,
    periodEnd: run.period_end,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    published: run.status === "published",
    overallScore: run.overall_score === null ? null : num(run.overall_score),
    platformScores: numberRecord(run.platform_scores),
    categoryScores: numberRecord(run.category_scores),
    summary: run.summary,
    accounts,
    engineVersion: run.engine_version,
    scoreStatus: scoreStatus(run),
    scoreReason: typeof scoring?.reason === "string" ? scoring.reason : null,
    dataConfidence: quality && typeof quality.confidence === "number"
      ? {
        confidence: quality.confidence,
        level: String(quality.level ?? "none"),
        coverageRatio: num(quality.coverageRatio as number),
        explanation: String(quality.explanation ?? ""),
      }
      : null,
    lastSuccessfulSync: typeof run.kpis.lastSuccessfulSync === "string" ? run.kpis.lastSuccessfulSync : null,
    limitations: Array.isArray(run.kpis.limitations) ? (run.kpis.limitations as unknown[]).filter((item): item is string => typeof item === "string") : [],
    scoringMethod: typeof scoring?.method === "string" ? scoring.method : null,
    platformScoring: platformScoring(scoring),
    platformCategoryScores: (run.kpis.platformCategoryScores ?? undefined) as Record<string, Record<string, number>> | undefined,
    synthetic: options.synthetic,
    findings: [...options.findings]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((finding) => ({
        severity: finding.severity,
        category: finding.category,
        platform: finding.platform,
        title: finding.title,
        description: finding.description,
        recommendation: finding.recommendation,
        reviewerNote: finding.reviewer_note,
        status: finding.status,
        estimatedImpact: finding.estimated_impact === null ? null : num(finding.estimated_impact),
        impactCurrency: finding.impact_currency,
        basis: typeof finding.evidence?.basis === "string" ? finding.evidence.basis : null,
        estimateLabel: typeof finding.evidence?.estimate_label === "string" ? finding.evidence.estimate_label : null,
        evidence: evidenceLines(finding.evidence),
      })),
    campaigns: options.campaigns
      .filter((campaign) => num(campaign.spend) > 0 || num(campaign.impressions) > 0)
      .map((campaign) => ({
        name: campaign.campaign_name ?? campaign.external_campaign_id,
        provider: campaign.provider,
        currency: campaign.currency,
        spend: num(campaign.spend),
        impressions: num(campaign.impressions),
        clicks: num(campaign.clicks),
        conversions: num(campaign.conversions),
        conversionValue: num(campaign.conversion_value),
      })),
  };
}
