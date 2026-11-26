// Shared audit types. Pure TypeScript: used by the run-audit and
// generate-report Edge Functions (Deno) and by the frontend (Vite).
//
// Engine 2.0 separates three things that 1.0 mixed together:
//   - data quality: what was actually retrieved, for which days and accounts;
//   - findings: what the retrieved data shows, each with its evidence;
//   - the score: only computed when the evidence is sufficient.

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

/** Categories that make up the performance score (data quality is reported as confidence). */
export type ScoredCategory = Exclude<FindingCategory, "data_quality">;

/**
 * How a finding is supported:
 *   verified   - directly measured or reported by the platform for the period
 *   indicative - a pattern in the data that suggests, but does not prove, an issue
 *   benchmark  - comparison with a sourced external benchmark (input.benchmarks)
 *   target     - comparison with a business target supplied for the account
 *   unavailable- the check could not be made; the finding documents the gap
 */
export type FindingBasis = "verified" | "indicative" | "benchmark" | "target" | "unavailable";

export type Scalar = string | number | boolean | null;

export type CampaignContext = {
  channelSubType?: string | null;
  servingStatus?: string | null;
  primaryStatus?: string | null;
  primaryStatusReasons?: string[];
  start?: string | null;
  end?: string | null;
  budgetId?: string | null;
  budgetShared?: boolean | null;
  budgetPeriod?: string | null;
  budgetReferenceCount?: number | null;
  lifetimeBudget?: number | null;
  budgetLevel?: "campaign" | "ad_set" | null;
  capturedAt?: string | null;
};

export type AuditAccount = {
  id: string;
  provider: Provider;
  name: string;
  currency: string | null;
  // Optional context (absent in demo data and legacy callers = unknown).
  externalId?: string | null;
  connectionId?: string | null;
  status?: string | null;
  timezone?: string | null;
  syncEnabled?: boolean | null;
  lastSyncedAt?: string | null;
};

export type AuditCampaign = {
  id: string;
  adAccountId: string;
  provider: Provider;
  name: string;
  objective: string | null;
  /** Status at the last sync. The status history is not stored. */
  status: string | null;
  channelType: string | null;
  bidStrategy: string | null;
  /** Daily budget at the last sync (budget changes during the period are unknown). */
  dailyBudget: number | null;
  impressions: number;
  reach: number;
  clicks: number;
  spend: number;
  conversions: number;
  conversionValue: number;
  activeDays: number;
  externalId?: string | null;
  currency?: string | null;
  details?: CampaignContext;
  /**
   * Platform-specific totals for the period (Meta: link_clicks, purchases,
   * leads, registrations, app_installs, landing_page_views, purchase_value).
   * null/undefined = not captured for every day with rows (unavailable).
   */
  platformMetrics?: Record<string, number> | null;
};

/** One campaign/day metric row (needed for per-campaign-type trends). */
export type CampaignDailyRow = {
  campaignId: string;
  adAccountId: string;
  date: string;
  impressions: number;
  reach: number;
  clicks: number;
  spend: number;
  conversions: number;
  conversionValue: number;
  platformMetrics?: Record<string, number> | null;
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
  currency?: string | null;
};

/**
 * One sync outcome for one ad account. `legacy` records come from jobs that
 * predate per-account results: the job completed without failed accounts,
 * so every selected account of the connection is assumed to have succeeded.
 */
export type SyncRunRecord = {
  adAccountId: string | null;
  connectionId: string | null;
  jobType: string;
  status: "succeeded" | "failed";
  completedAt: string | null;
  since: string | null;
  until: string | null;
  invalidValues: number;
  unavailableFields: string[];
  error: string | null;
  legacy: boolean;
  /**
   * True only when days without rows are proven to have had no delivery:
   * every result page was read, every fetched row was stored, and the
   * account totals for the window equal the summed rows. Legacy records and
   * runs without that proof leave such days unknown.
   */
  zeroDaysVerified: boolean;
  /** "mismatch" = account totals disagree with the stored rows (rows are incomplete). */
  reconciliation: "matched" | "mismatch" | "unverified";
  /** Campaigns with metrics that the platform no longer lists (stored as placeholders). */
  unresolvedCampaigns?: number;
};

export type DiagnosticSectionInput =
  | { status: "ok"; rows: Array<Record<string, unknown>>; truncated?: boolean }
  | { status: "unavailable"; reason: string };

export type AccountDiagnosticsInput = {
  adAccountId: string;
  provider: Provider;
  windowStart: string;
  windowEnd: string;
  capturedAt: string;
  sections: Record<string, DiagnosticSectionInput>;
};

/**
 * What a campaign is set up to achieve, derived from its objective, channel
 * and bid strategy. "conversions" = optimizes for conversions of an unknown
 * type (e.g. Target CPA); "unknown" = cannot be derived.
 */
export type CampaignGoal = "sales" | "leads" | "app" | "conversions" | "traffic" | "awareness" | "engagement";

/** Business targets supplied by PRISIM staff for an ad account (all optional). */
export type BusinessTarget = {
  adAccountId: string;
  targetCpa?: number | null;
  targetRoas?: number | null;
  goal?: CampaignGoal | null;
};

/** A sourced benchmark. Benchmarks are only applied when supplied. */
export type Benchmark = {
  metric: "ctr";
  provider: Provider;
  /** Campaign kind the benchmark applies to (see campaignKind()). */
  kind: string;
  value: number;
  source: string;
  applicability: string;
};

export type DataIssueLevel = "blocking" | "major" | "minor" | "info";

export type DataIssue = {
  code: string;
  level: DataIssueLevel;
  adAccountId: string | null;
  campaignId: string | null;
  message: string;
  details: Record<string, Scalar>;
};

export type AuditInput = {
  tenantName: string;
  periodStart: string;
  periodEnd: string;
  accounts: AuditAccount[];
  campaigns: AuditCampaign[];
  daily: AuditDailyRow[];
  /** Campaign/day rows for the period (optional; enables per-type trends). */
  campaignDaily?: CampaignDailyRow[];
  /** Sync outcomes. Undefined = unknown (coverage is then based on rows only). */
  syncRuns?: SyncRunRecord[];
  diagnostics?: AccountDiagnosticsInput[];
  targets?: BusinessTarget[];
  benchmarks?: Benchmark[];
  /** Problems found while reading the data (e.g. non-numeric values). */
  inputIssues?: DataIssue[];
  /** Time the audit is generated (ISO). Fixed in tests for determinism. */
  generatedAt?: string;
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

export type CoverageBasis = "sync_record" | "legacy_sync_record" | "rows_only";

export type AccountCoverage = {
  periodDays: number;
  /** Days inside a successful sync window for this account. */
  retrievedDays: number;
  /** Days with at least one metric row. */
  daysWithRows: number;
  /** Retrieved days without rows, proven to have had no delivery (see SyncRunRecord.zeroDaysVerified). */
  zeroDeliveryDays: number;
  /** Retrieved days without rows where no delivery could not be proven: unknown. */
  unverifiedDays: number;
  /** Days that were neither retrieved nor have rows: unknown, not zero. */
  missingDays: number;
  /** (period days - missing days - unverified days) / period days. */
  coverageRatio: number;
  basis: CoverageBasis;
  missingRanges: string[];
  lastSuccessfulSync: string | null;
  retrievedThrough: string | null;
};

export type ScoreStatus = "scored" | "provisional" | "unscored";

export type ConfidenceLevel = "high" | "medium" | "low" | "none";

export type AccountKpis = DerivedKpis & {
  adAccountId: string;
  provider: Provider;
  name: string;
  currency: string | null;
  campaignCount: number;
  /** Campaigns with impressions or spend in the period. */
  activeCampaignCount: number;
  coverage?: AccountCoverage;
  /** Platform-specific KPIs (e.g. Meta link CTR, cost per lead). null = unavailable. */
  platformKpis?: Record<string, number | null>;
  dataConfidence?: number;
  confidenceLevel?: ConfidenceLevel;
  score?: number | null;
  scoreStatus?: ScoreStatus;
  scoreReason?: string;
};

export type CampaignKpis = DerivedKpis & {
  campaignId: string;
  adAccountId: string;
  provider: Provider;
  name: string;
  currency: string | null;
  status: string | null;
  kind: string;
  goal: CampaignGoal | "unknown";
  dailyBudget: number | null;
  platformKpis?: Record<string, number | null>;
};

export type FindingEvidence = {
  /** Measured values (numbers rounded for display). */
  observed: Record<string, Scalar>;
  /** Thresholds or comparison values that were crossed. */
  thresholds: Record<string, Scalar>;
  period: { start: string; end: string; days: number };
  /** Where the data comes from (e.g. "daily metrics", "diagnostics 2026-10-26..2026-11-24"). */
  source: string;
  /** Information that was not available for this conclusion. */
  unavailable: string[];
  campaign?: string;
  account?: string;
  /** Source of a benchmark or target when basis is benchmark/target. */
  reference?: string;
};

export type AuditFinding = {
  ruleId: string;
  category: FindingCategory;
  severity: Severity;
  basis: FindingBasis;
  platform: Provider | null;
  adAccountId: string | null;
  campaignId: string | null;
  title: string;
  description: string;
  recommendation: string;
  evidence: FindingEvidence;
  /**
   * An estimate (never a confirmed loss or saving), in the account currency.
   * estimateLabel says what the number is.
   */
  estimatedImpact: number | null;
  estimateLabel: string | null;
  impactCurrency: string | null;
};

export type CategoryAssessment = {
  status: "assessed" | "not_assessed";
  score: number | null;
  weight: number;
  checks: string[];
  /** Checks that could not be evaluated, with the reason. */
  skipped: Array<{ ruleId: string; reason: string }>;
  penalties: Array<{ ruleId: string; campaignId: string | null; penalty: number }>;
  reason: string;
};

export type AccountScoring = {
  adAccountId: string;
  provider: Provider;
  status: ScoreStatus;
  score: number | null;
  /** Weighted score before severity caps. */
  uncappedScore: number | null;
  /** A verified critical/high finding caps the score (see the platform's scoring config). */
  cap: { limit: number; ruleId: string; severity: Severity } | null;
  reason: string;
  assessedWeight: number;
  categories: Record<ScoredCategory, CategoryAssessment>;
};

export type PlatformScore = {
  status: ScoreStatus;
  score: number | null;
  reason: string;
  accounts: number;
  scoredAccounts: number;
  /** False when the scored accounts were assessed on different areas. */
  comparable: boolean;
  weights: Record<ScoredCategory, number>;
  caps: Partial<Record<Severity, number>>;
};

export type ScoringReport = {
  /** Status across platforms (worst of the platform statuses). */
  status: ScoreStatus;
  /** Only set when exactly one platform was audited; never a Google/Meta average. */
  overall: number | null;
  reason: string;
  method: string;
  platforms: Partial<Record<Provider, PlatformScore>>;
  severityPenalties: Record<Severity, number>;
  accounts: AccountScoring[];
};

export type DataQualityReport = {
  confidence: number;
  level: ConfidenceLevel;
  coverageRatio: number;
  explanation: string;
  issues: DataIssue[];
  accounts: Array<{
    adAccountId: string;
    name: string;
    confidence: number;
    level: ConfidenceLevel;
    coverage: AccountCoverage;
    components: Record<string, number>;
  }>;
};

export type AuditResult = {
  engineVersion: string;
  overallScore: number | null;
  scoreStatus: ScoreStatus;
  platformScores: Partial<Record<Provider, number>>;
  categoryScores: Partial<Record<ScoredCategory, number>>;
  kpis: {
    currency: string | null; // null when accounts use different currencies
    totals: DerivedKpis | null; // null when currencies differ
    accounts: AccountKpis[];
    periodDays: number;
    dataDays: number;
    campaigns?: CampaignKpis[];
    /** Totals per platform (single currency only). Google and Meta totals are never added together. */
    platformTotals?: Partial<Record<Provider, DerivedKpis | null>>;
    dataQuality?: DataQualityReport;
    scoring?: ScoringReport;
    /** Category scores per platform (categories of different platforms are not comparable). */
    platformCategoryScores?: Partial<Record<Provider, Partial<Record<ScoredCategory, number>>>>;
    lastSuccessfulSync?: string | null;
    /**
     * Performance findings (data-quality findings excluded) by severity at
     * audit time, so a Not scored audit can still say what needs action.
     */
    findingCounts?: Record<Severity, number>;
    limitations?: string[];
    metricNotes?: string[];
    generatedAt?: string;
  };
  findings: AuditFinding[];
  summary: string;
};
