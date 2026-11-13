// Meta Marketing API client (Graph API). Uses the server-side app secret for
// the code exchange and appsecret_proof on every user-token call.

import {
  type AdProvider,
  type CampaignRecord,
  type DiscoveredAccount,
  type FetchLike,
  type MetricRecord,
  ProviderError,
  type ProviderIdentity,
  readJson,
  type SyncAccount,
  type TokenSet,
  toNumber,
} from "./types.ts";

export type MetaConfig = {
  appId: string;
  appSecret: string;
  redirectUri: string;
  apiVersion: string;
};

export const META_SCOPES = ["ads_read", "business_management"];

// Currencies whose Meta budgets are not expressed in 1/100 units.
const ZERO_DECIMAL = new Set(["CLP", "COP", "CRC", "HUF", "ISK", "IDR", "JPY", "KRW", "PYG", "TWD", "VND"]);

type GraphError = { error?: { code?: number; error_subcode?: number; message?: string; type?: string } };

function metaError(status: number, body: GraphError): ProviderError {
  const code = body.error?.code;
  const detail = `meta ${status} code=${code ?? "?"} subcode=${body.error?.error_subcode ?? "?"}`;
  if (code === 190 || status === 401) return new ProviderError("auth_expired", "The Meta connection has expired. Reconnect the account.", detail);
  if (code === 10 || (code !== undefined && code >= 200 && code < 300) || status === 403) {
    return new ProviderError("permission_denied", "Meta denied access. Confirm the ads_read permission and account access.", detail);
  }
  if (code === 4 || code === 17 || code === 32 || code === 613 || (code !== undefined && code >= 80000 && code <= 80014)) {
    return new ProviderError("rate_limited", "Meta rate limit reached. The sync will retry later.", detail);
  }
  return new ProviderError("provider_error", "Meta returned an error.", detail);
}

async function appSecretProof(token: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token)));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function accountStatus(value: unknown): DiscoveredAccount["status"] {
  switch (toNumber(value)) {
    case 1:
      return "active";
    case 2:
      return "disabled";
    case 100:
    case 101:
      return "closed";
    case 3:
    case 7:
    case 8:
    case 9:
      return "paused";
    default:
      return "unknown";
  }
}

type ActionStat = { action_type?: string; value?: string };

const PURCHASE_TYPES = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];
const LEAD_TYPES = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"];
const REGISTRATION_TYPES = ["complete_registration", "offsite_conversion.fb_pixel_complete_registration"];

/** Meta reports overlapping action types; take the first available per family. */
export function metaConversions(actions: ActionStat[] | undefined, values: ActionStat[] | undefined) {
  const pick = (stats: ActionStat[] | undefined, types: string[]) => {
    for (const type of types) {
      const found = stats?.find((stat) => stat.action_type === type);
      if (found) return toNumber(found.value);
    }
    return 0;
  };
  return {
    conversions: pick(actions, PURCHASE_TYPES) + pick(actions, LEAD_TYPES) + pick(actions, REGISTRATION_TYPES),
    conversionValue: pick(values, PURCHASE_TYPES),
  };
}

export function createMetaProvider(config: MetaConfig, fetcher: FetchLike = fetch): AdProvider {
  const graph = `https://graph.facebook.com/${config.apiVersion}`;

  async function call(path: string, params: Record<string, string>, token?: string, method = "GET") {
    const url = new URL(path.startsWith("http") ? path : `${graph}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (token) {
      url.searchParams.set("access_token", token);
      url.searchParams.set("appsecret_proof", await appSecretProof(token, config.appSecret));
    }
    const response = await fetcher(url.toString(), { method });
    const body = (await readJson(response)) as GraphError & Record<string, unknown>;
    if (!response.ok || body.error) throw metaError(response.status, body);
    return body;
  }

  async function paged<T>(path: string, params: Record<string, string>, token: string, limit = 5000): Promise<T[]> {
    const items: T[] = [];
    let body = await call(path, params, token);
    for (;;) {
      items.push(...((body.data as T[]) ?? []));
      const next = (body.paging as { next?: string } | undefined)?.next;
      if (!next || items.length >= limit) return items;
      // `next` already carries all parameters, including the token.
      const response = await fetcher(next);
      body = (await readJson(response)) as GraphError & Record<string, unknown>;
      if (!response.ok || body.error) throw metaError(response.status, body);
    }
  }

  async function exchange(params: Record<string, string>): Promise<TokenSet> {
    const body = await call("/oauth/access_token", {
      client_id: config.appId,
      client_secret: config.appSecret,
      ...params,
    });
    const accessToken = typeof body.access_token === "string" ? body.access_token : "";
    if (!accessToken) throw new ProviderError("provider_error", "Meta did not return an access token.");
    const expiresIn = toNumber(body.expires_in);
    return {
      accessToken,
      refreshToken: null,
      expiresAt: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      scopes: null,
    };
  }

  return {
    provider: "meta",

    authorizeUrl(state) {
      const url = new URL(`https://www.facebook.com/${config.apiVersion}/dialog/oauth`);
      url.searchParams.set("client_id", config.appId);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", META_SCOPES.join(","));
      return url.toString();
    },

    async exchangeCode(code) {
      const shortLived = await exchange({ redirect_uri: config.redirectUri, code });
      // Long-lived user token (about 60 days). Meta has no refresh token;
      // when it expires the connection is marked expired and must reconnect.
      const longLived = await exchange({ grant_type: "fb_exchange_token", fb_exchange_token: shortLived.accessToken });
      const permissions = await call("/me/permissions", {}, longLived.accessToken);
      const granted = ((permissions.data as Array<{ permission?: string; status?: string }>) ?? [])
        .filter((item) => item.status === "granted" && typeof item.permission === "string")
        .map((item) => item.permission as string);
      if (!granted.includes("ads_read")) {
        throw new ProviderError("permission_denied", "The ads_read permission was not granted. Reconnect and allow access to ad accounts.");
      }
      return { ...longLived, scopes: granted };
    },

    async refresh(): Promise<TokenSet> {
      throw new ProviderError("auth_expired", "Meta tokens cannot be refreshed. Reconnect the account.");
    },

    async identity(accessToken): Promise<ProviderIdentity> {
      const body = await call("/me", { fields: "id,name" }, accessToken);
      return { id: typeof body.id === "string" ? body.id : null, name: typeof body.name === "string" ? body.name : null };
    },

    async listAccounts(accessToken) {
      const rows = await paged<Record<string, unknown>>(
        "/me/adaccounts",
        { fields: "account_id,name,currency,timezone_name,account_status", limit: "100" },
        accessToken,
        500,
      );
      return rows
        .filter((row) => typeof row.account_id === "string")
        .map((row) => ({
          external_account_id: `act_${row.account_id}`,
          account_name: typeof row.name === "string" ? row.name : null,
          currency: typeof row.currency === "string" ? row.currency : null,
          timezone: typeof row.timezone_name === "string" ? row.timezone_name : null,
          status: accountStatus(row.account_status),
          metadata: {},
        }));
    },

    async fetchCampaigns(accessToken, account: SyncAccount): Promise<CampaignRecord[]> {
      const divisor = ZERO_DECIMAL.has(account.currency ?? "") ? 1 : 100;
      const rows = await paged<Record<string, unknown>>(
        `/${account.external_account_id}/campaigns`,
        { fields: "id,name,objective,effective_status,daily_budget,bid_strategy,buying_type", limit: "200" },
        accessToken,
      );
      return rows
        .filter((row) => typeof row.id === "string")
        .map((row) => ({
          external_id: row.id as string,
          name: typeof row.name === "string" ? row.name : null,
          objective: typeof row.objective === "string" ? row.objective : null,
          status: typeof row.effective_status === "string" ? row.effective_status : null,
          daily_budget: row.daily_budget === undefined ? null : toNumber(row.daily_budget) / divisor,
          bid_strategy: typeof row.bid_strategy === "string" ? row.bid_strategy : null,
          channel_type: typeof row.buying_type === "string" ? row.buying_type : null,
        }));
    },

    async fetchMetrics(accessToken, account, since, until): Promise<MetricRecord[]> {
      const params = (fields: string) => ({
        level: "campaign",
        time_increment: "1",
        time_range: JSON.stringify({ since, until }),
        fields,
        limit: "500",
      });
      let rows: Array<Record<string, unknown>>;
      try {
        rows = await paged(`/${account.external_account_id}/insights`, params("campaign_id,impressions,reach,clicks,spend,actions,action_values,date_start"), accessToken, 20000);
      } catch (error) {
        // Some API versions restrict `reach` with daily breakdowns; retry without it.
        if (!(error instanceof ProviderError) || error.code !== "provider_error") throw error;
        rows = await paged(`/${account.external_account_id}/insights`, params("campaign_id,impressions,clicks,spend,actions,action_values,date_start"), accessToken, 20000);
      }
      return rows
        .filter((row) => typeof row.campaign_id === "string" && typeof row.date_start === "string")
        .map((row) => {
          const { conversions, conversionValue } = metaConversions(row.actions as ActionStat[], row.action_values as ActionStat[]);
          return {
            external_campaign_id: row.campaign_id as string,
            date: row.date_start as string,
            impressions: Math.round(toNumber(row.impressions)),
            reach: Math.round(toNumber(row.reach)),
            clicks: Math.round(toNumber(row.clicks)),
            spend: toNumber(row.spend),
            conversions,
            conversion_value: conversionValue,
          };
        });
    },

    async revoke(accessToken) {
      await call("/me/permissions", {}, accessToken, "DELETE");
    },
  };
}
