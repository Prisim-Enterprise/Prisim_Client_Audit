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
};

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
