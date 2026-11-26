import { formatMoney, formatMultiple, formatNumber, formatPercent } from "@functions/_shared/format.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ClipboardCheck, Lightbulb, Play } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ScoreBar, ScoreRing } from "../../components/charts/ScoreRing";
import { ProviderBadge, SeverityBadge, StatusBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Select, Textarea } from "../../components/ui/Controls";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/Dialog";
import { Field } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { EmptyState, SectionCard } from "../../components/ui/States";
import { CATEGORY_LABELS, formatDate, presetRange } from "../../lib/analytics";
import { queryKeys, useApi } from "../../lib/api/ApiProvider";
import { errorMessage } from "../../lib/api/errors";
import type { AuditFinding, AuditRun, FindingPatch, FindingStatus, Severity, Tenant } from "../../lib/api/types";

type ScoreState = "scored" | "provisional" | "unscored";
type Platform = "google" | "meta";
const PLATFORM_LABEL: Record<Platform, string> = { google: "Google Ads", meta: "Meta Ads" };

/** Engine 2.x stores the score status; for 1.0 runs it is derived from the score. */
export function scoreStatusOf(run: AuditRun): ScoreState {
  return run.kpis?.score_status ?? (run.overall_score === null && Object.keys(run.platform_scores ?? {}).length === 0 ? "unscored" : "scored");
}

/**
 * Per-platform scores. Engine 2.1 stores status and reason per platform; older
 * runs only have platform_scores (treated as final, as they were published).
 */
export function platformScoresOf(run: AuditRun): Array<{ provider: Platform; score: number | null; status: ScoreState; reason: string | null }> {
  const platforms = run.kpis?.scoring?.platforms;
  if (platforms && Object.keys(platforms).length > 0) {
    return (["google", "meta"] as const).flatMap((provider) => {
      const item = platforms[provider];
      return item ? [{ provider, score: item.score, status: item.status, reason: item.reason }] : [];
    });
  }
  return (["google", "meta"] as const)
    .filter((provider) => run.platform_scores?.[provider] !== undefined)
    .map((provider) => ({ provider, score: run.platform_scores[provider] ?? null, status: scoreStatusOf(run), reason: null }));
}

/** Compact text for tables: platform scores separately, never a combined number. */
export function RunScore({ run }: { run: AuditRun }) {
  const platforms = platformScoresOf(run);
  if (platforms.length === 0) {
    return run.overall_score === null ? <span className="text-slate-500">Not scored</span> : <span>{Math.round(run.overall_score)}</span>;
  }
  return (
    <span className="inline-flex flex-wrap justify-end gap-x-3 gap-y-1">
      {platforms.map((item) => (
        <span key={item.provider} className="whitespace-nowrap">
          <span className="text-xs font-normal text-slate-500">{item.provider === "google" ? "Google" : "Meta"} </span>
          {item.score === null ? <span className="text-slate-500">Not scored</span> : Math.round(item.score)}
          {item.score !== null && item.status === "provisional" && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-semibold uppercase text-amber-900">Provisional</span>}
        </span>
      ))}
    </span>
  );
}

/** One ring per platform; Google and Meta are never shown as one number. */
export function PlatformScoreRings({ run, size = 120 }: { run: AuditRun; size?: number }) {
  const platforms = platformScoresOf(run);
  if (platforms.length === 0) return <ScoreRing score={run.overall_score} size={size} status={scoreStatusOf(run)} />;
  return (
    <div className="flex flex-wrap justify-center gap-6">
      {platforms.map((item) => (
        <div key={item.provider} className="flex flex-col items-center gap-2">
          <ProviderBadge provider={item.provider} />
          <ScoreRing score={item.score} size={size} status={item.score === null ? "unscored" : item.status} />
        </div>
      ))}
    </div>
  );
}

/** Prominent banner for provisional and unscored audits. */
export function ScoreStatusBanner({ run }: { run: AuditRun }) {
  const platforms = platformScoresOf(run);
  const provisional = platforms.filter((item) => item.score !== null && item.status === "provisional");
  const unscored = platforms.filter((item) => item.score === null);
  if (provisional.length === 0 && unscored.length === 0 && !(platforms.length === 0 && run.overall_score === null)) return null;
  const reasons = [...provisional, ...unscored].map((item) => `${PLATFORM_LABEL[item.provider]}: ${item.reason ?? (item.score === null ? "not scored" : "provisional")}`);
  const allUnscored = platforms.length === 0 ? run.overall_score === null : unscored.length === platforms.length;
  return (
    <div role="status" className={`rounded-xl border-2 p-4 ${allUnscored ? "border-slate-300 bg-slate-50" : "border-amber-400 bg-amber-50"}`}>
      <p className={`text-sm font-semibold ${allUnscored ? "text-slate-800" : "text-amber-900"}`}>
        {allUnscored ? "Not scored: there is not enough verified data for a performance score." : "Provisional score: the data behind it is incomplete or not fully verified."}
      </p>
      {reasons.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs leading-5 text-slate-700">
          {reasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      )}
    </div>
  );
}

const CONFIDENCE_TONE: Record<string, string> = {
  high: "bg-accent-50 text-accent-800",
  medium: "bg-amber-50 text-amber-800",
  low: "bg-rose-50 text-rose-800",
  none: "bg-slate-100 text-slate-700",
};

function money(value: number | null | undefined, currency: string | null, digits = 2) {
  return formatMoney(value ?? null, currency, digits);
}

function PlatformKpis({ provider, run }: { provider: Platform; run: AuditRun }) {
  const totals = run.kpis.platformTotals?.[provider] ?? (platformScoresOf(run).length <= 1 ? run.kpis.totals ?? null : null);
  const accounts = (run.kpis.accounts ?? []).filter((account) => account.provider === provider);
  const currencies = new Set(accounts.map((account) => account.currency ?? ""));
  const currency = currencies.size === 1 ? accounts[0]?.currency ?? null : null;
  if (!totals) {
    return <p className="text-sm text-slate-500">{PLATFORM_LABEL[provider]} accounts use different currencies, so totals are shown per account below.</p>;
  }
  const meta = provider === "meta";
  // Meta platform KPIs are summed per account; only shown when every account reports them.
  const sum = (key: string) => {
    let total = 0;
    for (const account of accounts) {
      const value = account.platformKpis?.[key];
      if (value === null || value === undefined) return null;
      total += value;
    }
    return accounts.length > 0 ? total : null;
  };
  const tiles: Array<[string, string]> = meta
    ? [
      ["Spend", money(totals.spend, currency, 0)],
      ["Impressions", formatNumber(totals.impressions)],
      ["CPM", money(totals.cpm, currency)],
      ["Link clicks", sum("link_clicks") === null ? "Unavailable" : formatNumber(sum("link_clicks"))],
      ["Link CTR", sum("link_clicks") === null ? "Unavailable" : formatPercent((sum("link_clicks") as number) / Math.max(totals.impressions, 1))],
      ["Purchases", sum("purchases") === null ? "Unavailable" : formatNumber(sum("purchases"), 0)],
      ["Leads", sum("leads") === null ? "Unavailable" : formatNumber(sum("leads"), 0)],
      ["App installs", sum("app_installs") === null ? "Unavailable" : formatNumber(sum("app_installs"), 0)],
    ]
    : [
      ["Spend", money(totals.spend, currency, 0)],
      ["Impressions", formatNumber(totals.impressions)],
      ["Clicks", formatNumber(totals.clicks)],
      ["CTR", formatPercent(totals.ctr)],
      ["Avg. CPC", money(totals.cpc, currency)],
      ["Conversions", formatNumber(totals.conversions, 0)],
      ["Cost / conversion", money(totals.cpa, currency)],
      ["ROAS", totals.conversionValue > 0 ? formatMultiple(totals.roas) : "No value reported"],
    ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {tiles.map(([label, value]) => <Kpi key={label} label={label} value={value} />)}
    </div>
  );
}

export function AuditOverview({ run }: { run: AuditRun }) {
  const quality = run.kpis.dataQuality;
  const scoring = run.kpis.scoring;
  const platforms = platformScoresOf(run);
  const providers: Platform[] = platforms.length > 0 ? platforms.map((item) => item.provider) : [];
  const categoriesFor = (provider: Platform | null) =>
    Object.entries(provider ? run.kpis.platformCategoryScores?.[provider] ?? (providers.length === 1 ? run.category_scores ?? {} : {}) : run.category_scores ?? {});
  const notAssessedFor = (provider: Platform) => {
    const scored = new Set(categoriesFor(provider).map(([category]) => category));
    const account = scoring?.accounts.find((item) => item.provider === provider);
    return account ? Object.keys(account.categories).filter((category) => !scored.has(category)) : [];
  };
  const accounts = run.kpis.accounts ?? [];
  const campaigns = run.kpis.campaigns ?? [];
  return (
    <div className="space-y-5">
      <ScoreStatusBanner run={run} />
      <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
        <div className="space-y-5">
          <Card className="flex flex-col items-center p-6">
            <p className="self-start text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Account health by platform</p>
            <div className="mt-4"><PlatformScoreRings run={run} /></div>
            {providers.length > 1 && <p className="mt-3 text-center text-xs text-slate-500">Google Ads and Meta Ads are scored separately and not combined.</p>}
          </Card>
          {quality && (
            <Card className="p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Data confidence (not a performance score)</p>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-semibold text-ink-950">{Math.round(quality.confidence)}</span>
                <span className="text-xs text-slate-400">/ 100</span>
                <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-medium capitalize ${CONFIDENCE_TONE[quality.level] ?? CONFIDENCE_TONE.none}`}>{quality.level}</span>
              </div>
              <dl className="mt-3 space-y-1 text-xs text-slate-600">
                <div className="flex justify-between"><dt>Days with known data</dt><dd className="font-medium text-ink-950">{formatPercent(quality.coverageRatio, 0)}</dd></div>
                <div className="flex justify-between"><dt>Reporting period</dt><dd className="font-medium text-ink-950">{formatDate(run.period_start)} – {formatDate(run.period_end)}</dd></div>
                <div className="flex justify-between gap-2"><dt>Last successful sync</dt><dd className="text-right font-medium text-ink-950">{run.kpis.lastSuccessfulSync ? formatDate(run.kpis.lastSuccessfulSync) : "Not recorded"}</dd></div>
              </dl>
              <p className="mt-3 text-xs leading-5 text-slate-500">{quality.explanation}</p>
            </Card>
          )}
        </div>
        <div className="space-y-5">
          {run.summary && (
            <Card className="p-5 sm:p-6">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Executive summary</p>
              <p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-700">{run.summary}</p>
            </Card>
          )}
          {(providers.length > 0 ? providers : [null]).map((provider) => {
            const categories = categoriesFor(provider);
            return (
              <Card key={provider ?? "all"} className="space-y-4 p-5 sm:p-6">
                {provider && <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400"><ProviderBadge provider={provider} /> Performance</p>}
                {provider ? <PlatformKpis provider={provider} run={run} /> : run.kpis.totals && (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <Kpi label="Spend" value={money(run.kpis.totals.spend, run.kpis.currency ?? null, 0)} />
                    <Kpi label="Conversions" value={formatNumber(run.kpis.totals.conversions, 0)} />
                    <Kpi label="Cost / conversion" value={money(run.kpis.totals.cpa, run.kpis.currency ?? null)} />
                    <Kpi label="CTR" value={formatPercent(run.kpis.totals.ctr)} />
                  </div>
                )}
                {categories.length > 0 && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    {categories.map(([category, score]) => <ScoreBar key={category} label={CATEGORY_LABELS[category] ?? category} score={Number(score)} />)}
                  </div>
                )}
                {provider && notAssessedFor(provider).length > 0 && (
                  <p className="text-xs text-slate-500">Not assessed (not enough data): {notAssessedFor(provider).map((category) => CATEGORY_LABELS[category] ?? category).join(", ")}.</p>
                )}
              </Card>
            );
          })}
        </div>
      </div>
      {accounts.length > 0 && accounts[0].coverage && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <caption className="px-5 pt-4 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Accounts reviewed</caption>
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-5 py-2 font-medium">Account</th>
                <th scope="col" className="px-3 py-2 font-medium">Known days</th>
                <th scope="col" className="px-3 py-2 font-medium">Confidence</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Spend</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Key result</th>
                <th scope="col" className="px-5 py-2 text-right font-medium">Score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {accounts.map((account) => {
                const unknown = (account.coverage?.missingDays ?? 0) + (account.coverage?.unverifiedDays ?? 0);
                const meta = account.provider === "meta";
                const result = meta
                  ? ["purchases", "leads", "app_installs"].map((key) => [key, account.platformKpis?.[key]] as const).filter(([, value]) => typeof value === "number" && value > 0).map(([key, value]) => `${formatNumber(value as number, 0)} ${key.replace("_", " ")}`).join(", ") || (account.platformKpis?.link_clicks === null || account.platformKpis?.link_clicks === undefined ? "Unavailable" : `${formatNumber(account.platformKpis.link_clicks)} link clicks`)
                  : `${formatNumber(account.conversions, 0)} conversions`;
                return (
                  <tr key={account.adAccountId}>
                    <td className="px-5 py-2"><span className="font-medium text-ink-950">{account.name}</span> <ProviderBadge provider={account.provider} /></td>
                    <td className="px-3 py-2 text-slate-600">
                      {account.coverage ? `${account.coverage.periodDays - unknown}/${account.coverage.periodDays}` : "–"}
                      {unknown > 0 && <span className="text-rose-700"> ({unknown} unknown)</span>}
                    </td>
                    <td className="px-3 py-2 capitalize text-slate-600">{account.confidenceLevel ?? "–"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(account.spend, account.currency, 0)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{result}</td>
                    <td className="px-5 py-2 text-right tabular-nums" title={account.scoreReason}>
                      {account.score === null || account.score === undefined ? "Not scored" : `${Math.round(account.score)}${account.scoreStatus === "provisional" ? " (provisional)" : ""}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      {campaigns.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <caption className="px-5 pt-4 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Campaign performance</caption>
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-5 py-2 font-medium">Campaign</th>
                <th scope="col" className="px-3 py-2 font-medium">Type / objective</th>
                <th scope="col" className="px-3 py-2 font-medium">Status at sync</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Spend</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Impr.</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">CTR</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Conv.</th>
                <th scope="col" className="px-5 py-2 text-right font-medium">Daily budget</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {campaigns.slice(0, 15).map((campaign) => {
                const meta = campaign.provider === "meta";
                const linkCtr = campaign.platformKpis?.link_ctr;
                return (
                  <tr key={campaign.campaignId}>
                    <td className="max-w-[260px] truncate px-5 py-2 font-medium text-ink-950" title={campaign.name}>{campaign.name}</td>
                    <td className="px-3 py-2 capitalize text-slate-600">{campaign.kind.replace("_", " ")}</td>
                    <td className="px-3 py-2 text-slate-600">{campaign.status ?? "–"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(campaign.spend, campaign.currency, 0)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatNumber(campaign.impressions)}</td>
                    <td className="px-3 py-2 text-right tabular-nums" title={meta ? "Link CTR" : "CTR"}>{meta ? (typeof linkCtr === "number" ? formatPercent(linkCtr) : "Unavailable") : formatPercent(campaign.ctr)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{meta ? "See objective" : formatNumber(campaign.conversions, 0)}</td>
                    <td className="px-5 py-2 text-right tabular-nums">{money(campaign.dailyBudget, campaign.currency, 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      {(run.kpis.limitations?.length ?? 0) > 0 && (
        <Card className="p-5 sm:p-6">
          <details>
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Limitations and unavailable data</summary>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-600">
              {[...(run.kpis.limitations ?? []), ...(run.kpis.metricNotes ?? [])].map((item) => <li key={item}>{item}</li>)}
            </ul>
            {scoring?.method && <p className="mt-3 text-xs leading-5 text-slate-500"><span className="font-medium">Scoring method:</span> {scoring.method}</p>}
          </details>
        </Card>
      )}
    </div>
  );
}

const BASIS_LABEL: Record<string, string> = {
  verified: "Verified finding",
  indicative: "Indicative observation",
  benchmark: "Benchmark comparison",
  target: "Target comparison",
  unavailable: "Unavailable data",
};

function formatEvidenceValue(value: unknown) {
  if (value === null || value === undefined) return "–";
  if (typeof value === "number") return Number.isInteger(value) ? formatNumber(value) : formatNumber(value, 2);
  return String(value);
}

function EvidenceDetails({ evidence }: { evidence: Record<string, unknown> }) {
  const observed = evidence.observed as Record<string, unknown> | undefined;
  if (!observed || typeof observed !== "object") {
    // Engine 1.0 findings: flat key/value evidence.
    return (
      <>
        {Object.entries(evidence).slice(0, 4).map(([key, value]) => (
          <span key={key}>{key.replace(/_/g, " ")}: <span className="text-slate-700">{formatEvidenceValue(value)}</span></span>
        ))}
      </>
    );
  }
  const thresholds = (evidence.thresholds ?? {}) as Record<string, unknown>;
  const period = evidence.period as { start?: string; end?: string } | undefined;
  const unavailable = Array.isArray(evidence.unavailable) ? (evidence.unavailable as string[]) : [];
  return (
    <details className="w-full">
      <summary className="cursor-pointer font-medium text-slate-600">Evidence</summary>
      <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {Object.entries(observed).filter(([, value]) => value !== null).map(([key, value]) => (
          <div key={`o-${key}`} className="flex justify-between gap-3"><dt>{key.replace(/_/g, " ")}</dt><dd className="text-right text-slate-700">{formatEvidenceValue(value)}</dd></div>
        ))}
        {Object.entries(thresholds).map(([key, value]) => (
          <div key={`t-${key}`} className="flex justify-between gap-3"><dt>threshold: {key.replace(/_/g, " ")}</dt><dd className="text-right text-slate-700">{formatEvidenceValue(value)}</dd></div>
        ))}
      </dl>
      <p className="mt-2">
        {period?.start && <>Period {period.start} to {period.end}. </>}
        {typeof evidence.source === "string" && <>Source: {evidence.source}. </>}
        {typeof evidence.reference === "string" && <>Reference: {evidence.reference}. </>}
      </p>
      {unavailable.length > 0 && <p className="mt-1">Not available: {unavailable.join("; ")}.</p>}
    </details>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold text-ink-950">{value}</p>
    </Card>
  );
}

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

export function FindingCard({
  finding,
  editable = false,
  onChange,
}: {
  finding: AuditFinding;
  editable?: boolean;
  onChange?: (patch: FindingPatch) => Promise<void>;
}) {
  const [note, setNote] = useState(finding.reviewer_note ?? "");
  const [saving, setSaving] = useState(false);
  const apply = async (patch: FindingPatch) => {
    if (!onChange) return;
    setSaving(true);
    try {
      await onChange(patch);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  const dismissed = finding.status === "dismissed";
  return (
    <Card className={dismissed ? "border-dashed bg-slate-50/60 opacity-75" : ""}>
      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={finding.severity} />
          {typeof finding.evidence?.basis === "string" && (
            <span className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-600">{BASIS_LABEL[finding.evidence.basis] ?? finding.evidence.basis}</span>
          )}
          <span className="text-xs text-slate-500">{CATEGORY_LABELS[finding.category] ?? finding.category}</span>
          {finding.platform && <ProviderBadge provider={finding.platform} />}
          {finding.status !== "open" && <StatusBadge status={finding.status} />}
        </div>
        <h3 className="mt-3 font-semibold leading-6 text-ink-950">{finding.title}</h3>
        <p className="mt-1.5 text-sm leading-6 text-slate-600">{finding.description}</p>
        <div className="mt-4 rounded-lg bg-accent-50/70 p-4">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-accent-700">
            <Lightbulb aria-hidden="true" className="h-3.5 w-3.5" /> Recommendation
          </p>
          <p className="mt-1.5 text-sm leading-6 text-ink-900">{finding.recommendation}</p>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
          {finding.estimated_impact !== null && finding.impact_currency && (
            <span className="font-medium text-orange-700">
              {typeof finding.evidence?.estimate_label === "string" ? finding.evidence.estimate_label : "Spend at risk (estimate)"}:{" "}
              {formatMoney(finding.estimated_impact, finding.impact_currency, 0)}
            </span>
          )}
          <EvidenceDetails evidence={(finding.evidence ?? {}) as Record<string, unknown>} />
        </div>
        {!editable && finding.reviewer_note && (
          <p className="mt-3 border-l-2 border-accent-500 pl-3 text-sm text-slate-700">
            <span className="font-medium">PRISIM note:</span> {finding.reviewer_note}
          </p>
        )}
      </div>
      {editable && (
        <div className="space-y-3 border-t border-slate-100 bg-slate-50/60 p-4 sm:px-6">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-36">
              <label htmlFor={`severity-${finding.id}`} className="mb-1 block text-xs font-medium text-slate-600">Severity</label>
              <Select id={`severity-${finding.id}`} value={finding.severity} disabled={saving} onChange={(event) => void apply({ severity: event.target.value as Severity })}>
                {SEVERITIES.map((severity) => <option key={severity} value={severity}>{severity}</option>)}
              </Select>
            </div>
            <div className="w-40">
              <label htmlFor={`status-${finding.id}`} className="mb-1 block text-xs font-medium text-slate-600">Review status</label>
              <Select id={`status-${finding.id}`} value={finding.status} disabled={saving} onChange={(event) => void apply({ status: event.target.value as FindingStatus })}>
                <option value="open">Open</option>
                <option value="accepted">Accepted</option>
                <option value="resolved">Resolved</option>
                <option value="dismissed">Dismissed (hidden from client)</option>
              </Select>
            </div>
          </div>
          <div>
            <label htmlFor={`note-${finding.id}`} className="mb-1 block text-xs font-medium text-slate-600">Reviewer note (visible to the client after publication)</label>
            <Textarea id={`note-${finding.id}`} className="min-h-16" maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} />
            <div className="mt-2 flex justify-end">
              <Button size="small" variant="secondary" loading={saving} disabled={note === (finding.reviewer_note ?? "")} onClick={() => void apply({ reviewer_note: note.trim() || null })}>
                Save note
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

export function FindingsList({
  findings,
  editable,
  onChange,
  emptyText = "No issues were identified for this period.",
}: {
  findings: AuditFinding[];
  editable?: boolean;
  onChange?: (findingId: string, patch: FindingPatch) => Promise<void>;
  emptyText?: string;
}) {
  const [severity, setSeverity] = useState<"all" | Severity>("all");
  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const finding of findings) result[finding.severity] = (result[finding.severity] ?? 0) + 1;
    return result;
  }, [findings]);
  const visible = findings.filter((finding) => severity === "all" || finding.severity === severity);
  if (findings.length === 0) {
    return <Card><EmptyState icon={<ClipboardCheck />} title="No findings" description={emptyText} /></Card>;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter findings by severity">
        {(["all", ...SEVERITIES] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={severity === value}
            onClick={() => setSeverity(value)}
            className={`rounded-full border px-3 py-1 text-xs font-medium capitalize transition ${severity === value ? "border-ink-950 bg-ink-950 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}
          >
            {value} {value === "all" ? findings.length : counts[value] ?? 0}
          </button>
        ))}
      </div>
      {visible.map((finding) => (
        <FindingCard key={finding.id} finding={finding} editable={editable} onChange={onChange ? (patch) => onChange(finding.id, patch) : undefined} />
      ))}
    </div>
  );
}

export function AuditRunTable({
  runs,
  tenants,
  linkTo,
}: {
  runs: AuditRun[];
  tenants?: Tenant[];
  linkTo: (run: AuditRun) => string;
}) {
  const names = new Map((tenants ?? []).map((tenant) => [tenant.id, tenant.business_name]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th scope="col" className="px-5 py-3 font-medium">Audit</th>
            {tenants && <th scope="col" className="px-3 py-3 font-medium">Client</th>}
            <th scope="col" className="px-3 py-3 font-medium">Period</th>
            <th scope="col" className="px-3 py-3 text-right font-medium">Score</th>
            <th scope="col" className="px-3 py-3 font-medium">Status</th>
            <th scope="col" className="px-5 py-3 font-medium"><span className="sr-only">Open</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {runs.map((run) => (
            <tr key={run.id} className="hover:bg-slate-50/70">
              <td className="px-5 py-3">
                <Link to={linkTo(run)} className="font-medium text-ink-950 hover:text-accent-700">{run.title}</Link>
                <p className="text-xs text-slate-500">Created {formatDate(run.created_at)}</p>
              </td>
              {tenants && <td className="px-3 py-3 text-slate-600">{names.get(run.tenant_id) ?? "–"}</td>}
              <td className="px-3 py-3 text-slate-600">{formatDate(run.period_start)} – {formatDate(run.period_end)}</td>
              <td className="px-3 py-3 text-right font-semibold tabular-nums text-ink-950">
                <RunScore run={run} />
              </td>
              <td className="px-3 py-3"><StatusBadge status={run.status} /></td>
              <td className="px-5 py-3 text-right">
                <Link to={linkTo(run)} className="inline-flex items-center gap-1 text-sm font-medium text-accent-700 hover:text-accent-800">
                  Open <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RunAuditButton({ tenantId, children }: { tenantId?: string; children?: ReactNode }) {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selectedTenant, setSelectedTenant] = useState(tenantId ?? "");
  const [days, setDays] = useState("30");
  const [title, setTitle] = useState("");
  const [accountIds, setAccountIds] = useState<string[] | null>(null);

  const tenantsQuery = useQuery({ queryKey: queryKeys.tenants, queryFn: () => api.listTenants(), enabled: open && !tenantId });
  const accountsQuery = useQuery({
    queryKey: queryKeys.adAccounts(selectedTenant),
    queryFn: () => api.listAdAccounts(selectedTenant),
    enabled: open && Boolean(selectedTenant),
  });
  const accounts = accountsQuery.data ?? [];
  const chosen = accountIds ?? accounts.filter((account) => account.sync_enabled).map((account) => account.id);

  const run = useMutation({
    mutationFn: () => {
      const range = presetRange(Number(days));
      return api.runAudit({
        tenantId: selectedTenant,
        periodStart: range.from,
        periodEnd: range.to,
        adAccountIds: chosen,
        title: title.trim() || undefined,
      });
    },
    onSuccess: ({ auditRunId }) => {
      toast.success("Audit complete. Review the findings before publishing.");
      void queryClient.invalidateQueries({ queryKey: ["audit-runs"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      setOpen(false);
      navigate(`/admin/audits/${auditRunId}`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Play aria-hidden="true" className="h-4 w-4" /> {children ?? "Run audit"}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !run.isPending && setOpen(next)}>
        <DialogContent className="max-w-xl">
          <DialogTitle>Run an advertising audit</DialogTitle>
          <DialogDescription>
            The audit engine analyses synced campaign data and creates a draft for PRISIM review. Clients see it only after you publish.
          </DialogDescription>
          <form
            className="mt-5 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              run.mutate();
            }}
          >
            {!tenantId && (
              <Field label="Client" htmlFor="audit-tenant">
                <Select id="audit-tenant" required value={selectedTenant} onChange={(event) => {
                  setSelectedTenant(event.target.value);
                  setAccountIds(null);
                }}>
                  <option value="">Choose a client…</option>
                  {(tenantsQuery.data ?? []).filter((tenant) => tenant.status === "active").map((tenant) => (
                    <option key={tenant.id} value={tenant.id}>{tenant.business_name}</option>
                  ))}
                </Select>
              </Field>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Audit period" htmlFor="audit-days">
                <Select id="audit-days" value={days} onChange={(event) => setDays(event.target.value)}>
                  <option value="14">Last 14 days</option>
                  <option value="30">Last 30 days</option>
                  <option value="60">Last 60 days</option>
                  <option value="90">Last 90 days</option>
                </Select>
              </Field>
              <Field label="Title (optional)" htmlFor="audit-title">
                <Input id="audit-title" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Q4 performance audit" />
              </Field>
            </div>
            {selectedTenant && (
              <fieldset>
                <legend className="text-sm font-medium text-slate-700">Ad accounts</legend>
                {accountsQuery.isLoading ? (
                  <p className="mt-2 text-sm text-slate-500">Loading accounts…</p>
                ) : accounts.length === 0 ? (
                  <p className="mt-2 text-sm text-slate-500">This client has no ad accounts yet.</p>
                ) : (
                  <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
                    {accounts.map((account) => (
                      <li key={account.id}>
                        <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-slate-50">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-slate-300 text-accent-600"
                            checked={chosen.includes(account.id)}
                            onChange={(event) =>
                              setAccountIds(event.target.checked ? [...chosen, account.id] : chosen.filter((value) => value !== account.id))}
                          />
                          <span className="min-w-0 flex-1 truncate">{account.account_name ?? account.external_account_id}</span>
                          <ProviderBadge provider={account.provider} />
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </fieldset>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={run.isPending}>Cancel</Button>
              <Button type="submit" loading={run.isPending} disabled={!selectedTenant || chosen.length === 0}>Run audit</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AuditSection({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return <SectionCard title={title} actions={actions}>{children}</SectionCard>;
}
