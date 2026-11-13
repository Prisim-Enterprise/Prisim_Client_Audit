// Google Ads API client (REST). OAuth 2.0 with PKCE and offline access; API
// calls need an approved developer token and, for client accounts managed
// through a manager (MCC), the manager id as login-customer-id.

import {
  type AdProvider,
  type CampaignRecord,
  type DiscoveredAccount,
  type FetchLike,
  type MetricRecord,
  ProviderError,
  readJson,
  type SyncAccount,
  type TokenSet,
  toNumber,
} from "./types.ts";

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  developerToken: string;
  redirectUri: string;
  apiVersion: string;
};

export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/adwords"];

type GoogleErrorBody = {
  error?: string | { code?: number; status?: string; message?: string; details?: unknown };
  error_description?: string;
};

function googleError(status: number, body: GoogleErrorBody): ProviderError {
  const error = typeof body.error === "object" ? body.error : undefined;
  const reason = typeof body.error === "string" ? body.error : error?.status ?? "";
  const text = JSON.stringify(error?.details ?? "");
  const detail = `google ${status} ${reason}`;
  if (status === 401 || reason === "invalid_grant" || reason === "UNAUTHENTICATED") {
    return new ProviderError("auth_expired", "The Google Ads connection has expired or was revoked. Reconnect the account.", detail);
  }
  if (/DEVELOPER_TOKEN_NOT_APPROVED|DEVELOPER_TOKEN_PROHIBITED/.test(text)) {
    return new ProviderError("permission_denied", "The Google Ads developer token is not approved for this account (test access only).", detail);
  }
  if (status === 403 || reason === "PERMISSION_DENIED") {
    return new ProviderError("permission_denied", "Google Ads denied access to this account.", detail);
  }
  if (status === 429 || reason === "RESOURCE_EXHAUSTED") {
    return new ProviderError("rate_limited", "Google Ads rate limit reached. The sync will retry later.", detail);
  }
  return new ProviderError("provider_error", "Google Ads returned an error.", detail);
}

function customerStatus(value: unknown): DiscoveredAccount["status"] {
  switch (value) {
    case "ENABLED":
      return "active";
    case "CANCELED":
    case "CLOSED":
      return "closed";
    case "SUSPENDED":
      return "disabled";
    default:
      return "unknown";
  }
}

export function microsToUnits(value: unknown): number {
  return toNumber(value) / 1_000_000;
}

type SearchRow = Record<string, Record<string, unknown> | undefined>;

export function createGoogleProvider(config: GoogleConfig, fetcher: FetchLike = fetch): AdProvider {
  const api = `https://googleads.googleapis.com/${config.apiVersion}`;

  async function token(params: Record<string, string>): Promise<TokenSet> {
    const response = await fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...params }).toString(),
    });
    const body = (await readJson(response)) as GoogleErrorBody & Record<string, unknown>;
    if (!response.ok) throw googleError(response.status, body);
    const accessToken = typeof body.access_token === "string" ? body.access_token : "";
    if (!accessToken) throw new ProviderError("provider_error", "Google did not return an access token.");
    const expiresIn = toNumber(body.expires_in);
    return {
      accessToken,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
      expiresAt: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      scopes: typeof body.scope === "string" ? body.scope.split(" ") : null,
    };
  }

  function headers(accessToken: string, loginCustomerId?: string) {
    const result: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": config.developerToken,
      "Content-Type": "application/json",
    };
    if (loginCustomerId) result["login-customer-id"] = loginCustomerId;
    return result;
  }

  async function search(accessToken: string, customerId: string, query: string, loginCustomerId?: string, limit = 50000) {
    const rows: SearchRow[] = [];
    let pageToken: string | undefined;
    do {
      const response = await fetcher(`${api}/customers/${customerId}/googleAds:search`, {
        method: "POST",
        headers: headers(accessToken, loginCustomerId),
        body: JSON.stringify(pageToken ? { query, pageToken } : { query }),
      });
      const body = (await readJson(response)) as GoogleErrorBody & { results?: SearchRow[]; nextPageToken?: string };
      if (!response.ok) throw googleError(response.status, body);
      rows.push(...(body.results ?? []));
      pageToken = body.nextPageToken || undefined;
    } while (pageToken && rows.length < limit);
    return rows;
  }

  function loginId(account: SyncAccount) {
    const value = account.metadata?.login_customer_id;
    return typeof value === "string" && /^\d{10}$/.test(value) ? value : undefined;
  }

  return {
    provider: "google",

    authorizeUrl(state, codeChallenge) {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("include_granted_scopes", "true");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },

    async exchangeCode(code, codeVerifier) {
      const result = await token({
        code,
        code_verifier: codeVerifier,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
      });
      if (result.scopes && !result.scopes.includes(GOOGLE_SCOPES[0])) {
        throw new ProviderError("permission_denied", "Google Ads access was not granted. Reconnect and allow the requested access.");
      }
      return result;
    },

    async refresh(refreshToken) {
      const result = await token({ refresh_token: refreshToken, grant_type: "refresh_token" });
      return { ...result, refreshToken: result.refreshToken ?? null };
    },

    async identity() {
      return { id: null, name: "Google Ads" };
    },

    async listAccounts(accessToken) {
      const response = await fetcher(`${api}/customers:listAccessibleCustomers`, { headers: headers(accessToken) });
      const body = (await readJson(response)) as GoogleErrorBody & { resourceNames?: string[] };
      if (!response.ok) throw googleError(response.status, body);
      const ids = (body.resourceNames ?? []).map((name) => name.replace("customers/", "")).filter((id) => /^\d{10}$/.test(id));

      const accounts = new Map<string, DiscoveredAccount>();
      for (const id of ids.slice(0, 50)) {
        let rows: SearchRow[];
        try {
          rows = await search(
            accessToken,
            id,
            "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status FROM customer LIMIT 1",
            id,
          );
        } catch (error) {
          // Accessible but not queryable (e.g. cancelled) accounts are skipped.
          if (error instanceof ProviderError && error.code === "permission_denied") continue;
          throw error;
        }
        const customer = rows[0]?.customer;
        if (!customer) continue;
        if (customer.manager === true) {
          const clients = await search(
            accessToken,
            id,
            "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.level <= 1 AND customer_client.manager = FALSE",
            id,
            500,
          );
          for (const row of clients) {
            const client = row.customerClient;
            const clientId = String(client?.id ?? "");
            if (!/^\d{10}$/.test(clientId) || accounts.has(clientId)) continue;
            accounts.set(clientId, {
              external_account_id: clientId,
              account_name: typeof client?.descriptiveName === "string" ? client.descriptiveName : null,
              currency: typeof client?.currencyCode === "string" ? client.currencyCode : null,
              timezone: typeof client?.timeZone === "string" ? client.timeZone : null,
              status: customerStatus(client?.status),
              metadata: { login_customer_id: id },
            });
          }
          continue;
        }
        accounts.set(id, {
          external_account_id: id,
          account_name: typeof customer.descriptiveName === "string" ? customer.descriptiveName : null,
          currency: typeof customer.currencyCode === "string" ? customer.currencyCode : null,
          timezone: typeof customer.timeZone === "string" ? customer.timeZone : null,
          status: customerStatus(customer.status),
          metadata: { login_customer_id: id },
        });
        if (accounts.size >= 200) break;
      }
      return [...accounts.values()];
    },

    async fetchCampaigns(accessToken, account): Promise<CampaignRecord[]> {
      const rows = await search(
        accessToken,
        account.external_account_id,
        "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED'",
        loginId(account),
      );
      return rows
        .filter((row) => row.campaign?.id !== undefined)
        .map((row) => ({
          external_id: String(row.campaign?.id),
          name: typeof row.campaign?.name === "string" ? row.campaign.name : null,
          objective: typeof row.campaign?.advertisingChannelType === "string" ? row.campaign.advertisingChannelType : null,
          status: typeof row.campaign?.status === "string" ? row.campaign.status : null,
          daily_budget: row.campaignBudget?.amountMicros === undefined ? null : microsToUnits(row.campaignBudget.amountMicros),
          bid_strategy: typeof row.campaign?.biddingStrategyType === "string" ? row.campaign.biddingStrategyType : null,
          channel_type: typeof row.campaign?.advertisingChannelType === "string" ? row.campaign.advertisingChannelType : null,
        }));
    },

    async fetchMetrics(accessToken, account, since, until): Promise<MetricRecord[]> {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
        throw new ProviderError("provider_error", "Invalid sync window.");
      }
      const rows = await search(
        accessToken,
        account.external_account_id,
        `SELECT campaign.id, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}' AND campaign.status != 'REMOVED'`,
        loginId(account),
      );
      return rows
        .filter((row) => row.campaign?.id !== undefined && typeof row.segments?.date === "string")
        .map((row) => ({
          external_campaign_id: String(row.campaign?.id),
          date: row.segments?.date as string,
          impressions: Math.round(toNumber(row.metrics?.impressions)),
          reach: 0, // Not reported per campaign/day by Google Ads.
          clicks: Math.round(toNumber(row.metrics?.clicks)),
          spend: microsToUnits(row.metrics?.costMicros),
          conversions: toNumber(row.metrics?.conversions),
          conversion_value: toNumber(row.metrics?.conversionsValue),
        }));
    },

    async revoke(accessToken, refreshToken) {
      await fetcher(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken ?? accessToken)}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    },
  };
}
