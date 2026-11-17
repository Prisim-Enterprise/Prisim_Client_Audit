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

export type CampaignRecord = {
  external_id: string;
  name: string | null;
  objective: string | null;
  status: string | null;
  daily_budget: number | null;
  bid_strategy: string | null;
  channel_type: string | null;
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

export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}
