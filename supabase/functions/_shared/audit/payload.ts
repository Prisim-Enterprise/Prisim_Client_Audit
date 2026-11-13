// Serializes an engine result for public.save_audit_run(p_tenant_id, p_run, p_findings).

import type { AuditResult } from "./types.ts";

export type SaveAuditPayload = {
  run: {
    title: string;
    period_start: string;
    period_end: string;
    engine_version: string;
    overall_score: number;
    platform_scores: Record<string, number>;
    category_scores: Record<string, number>;
    kpis: AuditResult["kpis"];
    summary: string;
    ad_account_ids: string[];
  };
  findings: Array<{
    ad_account_id: string | null;
    campaign_id: string | null;
    rule_id: string;
    category: string;
    platform: string | null;
    severity: string;
    title: string;
    description: string;
    recommendation: string;
    evidence: Record<string, unknown>;
    estimated_impact: number | null;
    impact_currency: string | null;
  }>;
};

function clip(value: string, length: number) {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

export function toSaveAuditPayload(
  result: AuditResult,
  options: { title: string; periodStart: string; periodEnd: string; adAccountIds: string[] },
): SaveAuditPayload {
  return {
    run: {
      title: clip(options.title.trim() || "Advertising audit", 200),
      period_start: options.periodStart,
      period_end: options.periodEnd,
      engine_version: result.engineVersion,
      overall_score: result.overallScore,
      platform_scores: result.platformScores as Record<string, number>,
      category_scores: result.categoryScores,
      kpis: result.kpis,
      summary: clip(result.summary, 5000),
      ad_account_ids: options.adAccountIds,
    },
    findings: result.findings.slice(0, 500).map((finding) => ({
      ad_account_id: finding.adAccountId,
      campaign_id: finding.campaignId,
      rule_id: finding.ruleId,
      category: finding.category,
      platform: finding.platform,
      severity: finding.severity,
      title: clip(finding.title, 240),
      description: clip(finding.description, 4000),
      recommendation: clip(finding.recommendation, 4000),
      evidence: finding.evidence,
      estimated_impact: finding.estimatedImpact,
      impact_currency: finding.impactCurrency,
    })),
  };
}
