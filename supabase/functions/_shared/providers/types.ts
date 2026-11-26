export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ProviderErrorCode =
  | "auth_expired"
  | "permission_denied"
  | "rate_limited"
  | "not_configured"
  | "provider_error";

/** Errors carry a code and a safe message; provider payloads are never echoed to browsers. */
export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, message: string, readonly detail?: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export type TokenSet = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scopes: string[] | null;
};

export type ProviderIdentity = {
  id: string | null;
  name: string | null;
};

export type DiscoveredAccount = {
  external_account_id: string;
  account_name: string | null;
  currency: string | null;
  timezone: string | null;
  status: "active" | "paused" | "disabled" | "closed" | "unknown";
  metadata: Record<string, string>;
};

/**
 * Non-secret campaign context stored in campaigns.details (JSONB). Every key is
 * optional: a missing key means the platform did not report it, never a default.
 */
export type CampaignDetails = {
  /** Google campaign.advertising_channel_sub_type (e.g. APP_CAMPAIGN). */
  channel_sub_type?: string | null;
  /** Google campaign.serving_status / Meta configured status. */
  serving_status?: string | null;
  /** Google campaign.primary_status (ELIGIBLE, LIMITED, ...). */
  primary_status?: string | null;
  primary_status_reasons?: string[];
  /** Start/end as reported (Google: customer time zone; Meta: ISO 8601). */
  start?: string | null;
  end?: string | null;
  budget_id?: string | null;
  budget_shared?: boolean | null;
  budget_period?: string | null;
  /** Number of campaigns using the budget (Google campaign_budget.reference_count). */
  budget_reference_count?: number | null;
  lifetime_budget?: number | null;
  /** Where the budget is set (Meta: "campaign" for CBO, "ad_set" otherwise). */
  budget_level?: "campaign" | "ad_set" | null;
  /** UTC time the platform returned these values. */
  captured_at?: string;
};

export type CampaignRecord = {
  external_id: string;
  name: string | null;
  objective: string | null;
  status: string | null;
  daily_budget: number | null;
  bid_strategy: string | null;
  channel_type: string | null;
  details?: CampaignDetails;
};

export type MetricRecord = {
  external_campaign_id: string;
  date: string;
  impressions: number;
  reach: number;
  clicks: number;
  spend: number;
  conversions: number;
  conversion_value: number;
  /**
   * Fields the platform returned in a non-numeric form. The stored value is 0,
   * so the sync records the count as a data-quality problem (not stored per row).
   */
  invalid_fields?: string[];
};

/**
 * Account-level diagnostics captured during a sync (latest snapshot per ad
 * account). Each section is independently "ok", "unavailable" (API refused or
 * not applicable) or absent. Values are raw platform enums and numbers.
 */
export type DiagnosticSection<T> = { status: "ok"; rows: T[]; truncated?: boolean } | { status: "unavailable"; reason: string };

export type AccountDiagnostics = {
  provider: "meta" | "google";
  window: { since: string; until: string };
  captured_at: string;
  sections: Record<string, DiagnosticSection<Record<string, unknown>>>;
};

export type SyncAccount = {
  id: string;
  external_account_id: string;
  currency: string | null;
  timezone: string | null;
  metadata: Record<string, unknown>;
};

export interface AdProvider {
  readonly provider: "meta" | "google";
  authorizeUrl(state: string, codeChallenge: string): string;
  exchangeCode(code: string, codeVerifier: string): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  identity(accessToken: string): Promise<ProviderIdentity>;
  listAccounts(accessToken: string): Promise<DiscoveredAccount[]>;
  fetchCampaigns(accessToken: string, account: SyncAccount): Promise<CampaignRecord[]>;
  fetchMetrics(accessToken: string, account: SyncAccount, since: string, until: string): Promise<MetricRecord[]>;
  /** Optional diagnostics; a failure here never fails the metric sync. */
  fetchDiagnostics?(accessToken: string, account: SyncAccount, since: string, until: string): Promise<AccountDiagnostics>;
  revoke(accessToken: string, refreshToken: string | null): Promise<void>;
}

export function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Like toNumber, but records the field name in `invalid` when the platform sent
 * something that is present yet not a finite number. Absent values (undefined,
 * null, "") are legitimately 0 for platform metrics and are not recorded.
 */
export function checkedNumber(value: unknown, field: string, invalid: string[]): number {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  invalid.push(field);
  return 0;
}

/** Runs one diagnostic query; maps any provider failure to "unavailable" with a safe reason. */
export async function diagnosticSection<T extends Record<string, unknown>>(
  load: () => Promise<{ rows: T[]; truncated?: boolean }>,
): Promise<DiagnosticSection<T>> {
  try {
    const { rows, truncated } = await load();
    return truncated ? { status: "ok", rows, truncated } : { status: "ok", rows };
  } catch (error) {
    if (error instanceof ProviderError && error.code === "auth_expired") throw error;
    return { status: "unavailable", reason: error instanceof ProviderError ? `${error.code}: ${error.message}` : "unexpected error" };
  }
}

export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}
