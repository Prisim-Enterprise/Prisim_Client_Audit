// Meta Marketing API client (Graph API). Uses the server-side app secret for
// the code exchange and appsecret_proof on every token call.
//
// Two connection modes, chosen by configuration only (never by fallback):
//   - Facebook Login for Business with a business integration system user
//     access token (META_LOGIN_CONFIG_ID set). Consent sends config_id,
//     response_type=code and override_default_response_type=true. The code is
//     exchanged once; the token is validated with /debug_token (is_valid,
//     app_id, scopes + granular_scopes) and ad accounts are limited to the
//     ad account IDs granted to ads_read. No fb_exchange_token, no
//     /me/permissions, no /me/adaccounts.
//   - Classic user login with `scope` (no configuration ID): long-lived user
//     token and /me/permissions, unchanged.

import {
  type AccountDiagnostics,
  type AdProvider,
  type CampaignRecord,
  checkedNumber,
  diagnosticSection,
  MAX_METRIC_ROWS,
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
  /**
   * Facebook Login for Business configuration ID (META_LOGIN_CONFIG_ID) whose
   * token type is "System user access token". When set, the system user flow
   * is used and the configuration decides the permissions, so `scope` is not
   * sent. Not a secret.
   */
  loginConfigId?: string | null;
};

export const META_SCOPES = ["ads_read", "business_management"];

/** Most ad accounts one system user connection may discover. */
export const MAX_GRANTED_AD_ACCOUNTS = 200;

const ACCOUNT_FIELDS = "id,account_id,name,currency,timezone_name,account_status";

type DebugTokenData = {
  is_valid?: unknown;
  app_id?: unknown;
  expires_at?: unknown;
  scopes?: unknown;
  granular_scopes?: unknown;
};

/** What a validated system user token may access. Never contains the token. */
export type MetaTokenGrant = {
  scopes: string[];
  /** Numeric ad account IDs granted to ads_read (without the act_ prefix). */
  adAccountIds: string[];
  expiresAt: string | null;
};

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

const SCOPE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const NUMERIC_ID = /^[1-9][0-9]{0,24}$/;

/** A Graph ID from JSON. Unsafe integers would have lost precision: reject them. */
function graphId(value: unknown): string | null {
  if (typeof value === "string") return NUMERIC_ID.test(value) ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

/**
 * Validates /debug_token output for this app. Throws a ProviderError whose
 * detail holds only permission names and counts (never tokens or the full
 * response). Fails closed when ads_read has no explicitly granted ad accounts.
 */
export function evaluateDebugToken(data: DebugTokenData | undefined, appId: string): MetaTokenGrant {
  const valid = data?.is_valid === true;
  const appMatch = data !== undefined && (typeof data.app_id === "string" || typeof data.app_id === "number")
    && String(data.app_id) === appId;

  const names = new Set<string>();
  if (Array.isArray(data?.scopes)) {
    for (const scope of data.scopes) if (typeof scope === "string" && SCOPE_NAME.test(scope)) names.add(scope);
  }
  const granular = Array.isArray(data?.granular_scopes) ? data.granular_scopes as Array<{ scope?: unknown; target_ids?: unknown }> : [];
  const adsReadIds = new Set<string>();
  let adsReadAllTargets = false;
  let rejectedIds = 0;
  for (const entry of granular) {
    if (typeof entry?.scope !== "string" || !SCOPE_NAME.test(entry.scope)) continue;
    names.add(entry.scope);
    if (entry.scope !== "ads_read") continue;
    if (!Array.isArray(entry.target_ids)) {
      adsReadAllTargets = true;
      continue;
    }
    for (const raw of entry.target_ids) {
      const id = graphId(raw);
      if (id) adsReadIds.add(id);
      else rejectedIds++;
    }
  }

  const detail = `meta debug_token valid=${valid} app_match=${appMatch} scopes=[${[...names].sort().join(",")}]`
    + ` ads_read_targets=${adsReadAllTargets ? "unrestricted" : adsReadIds.size}${rejectedIds ? ` rejected_ids=${rejectedIds}` : ""}`;

  if (!valid || !appMatch) {
    throw new ProviderError("permission_denied", "Meta could not confirm this connection for PRISIM. Start the connection again.", detail);
  }
  if (!names.has("ads_read")) {
    throw new ProviderError("permission_denied", "The ads_read permission was not granted. Reconnect and allow access to ad accounts.", detail);
  }
  if (adsReadIds.size === 0) {
    // ads_read without explicit ad account IDs cannot be limited to granted assets.
    throw new ProviderError("permission_denied", "No ad account was shared with PRISIM. Reconnect and select the ad account to share.", detail);
  }
  if (adsReadIds.size > MAX_GRANTED_AD_ACCOUNTS) {
    throw new ProviderError("permission_denied", `More than ${MAX_GRANTED_AD_ACCOUNTS} ad accounts were shared. Share fewer ad accounts.`, detail);
  }

  const expires = toNumber(data?.expires_at);
  return {
    scopes: [...names].sort(),
    adAccountIds: [...adsReadIds].sort(),
    // 0 means the system user token does not expire.
    expiresAt: expires > 0 ? new Date(expires * 1000).toISOString() : null,
  };
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

/**
 * Per-family results (Ads Action Stats). Families are kept separate: a sales
 * campaign is judged on purchases, a leads campaign on leads, an app campaign
 * on installs. Within a family the first available type is used because Meta
 * reports overlapping types (e.g. "lead" includes on-Facebook leads).
 */
const RESULT_TYPES: Record<string, string[]> = {
  purchases: ["omni_purchase", "offsite_conversion.fb_pixel_purchase", "onsite_conversion.purchase", "purchase"],
  leads: ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"],
  registrations: ["omni_complete_registration", "offsite_conversion.fb_pixel_complete_registration", "complete_registration"],
  app_installs: ["omni_app_install", "mobile_app_install", "app_install"],
  landing_page_views: ["landing_page_view"],
};

/** platform_metrics for one insights row; keys are present only when Meta reported them. */
export function metaResults(row: Record<string, unknown>, invalid: string[] = []): Record<string, number> {
  const actions = Array.isArray(row.actions) ? (row.actions as ActionStat[]) : [];
  const values = Array.isArray(row.action_values) ? (row.action_values as ActionStat[]) : [];
  const result: Record<string, number> = {};
  if (row.inline_link_clicks !== undefined) result.link_clicks = Math.round(checkedNumber(row.inline_link_clicks, "inline_link_clicks", invalid));
  for (const [family, types] of Object.entries(RESULT_TYPES)) {
    const found = types.map((type) => actions.find((stat) => stat.action_type === type)).find(Boolean);
    result[family] = found ? checkedNumber(found.value, family, invalid) : 0;
  }
  const value = RESULT_TYPES.purchases.map((type) => values.find((stat) => stat.action_type === type)).find(Boolean);
  result.purchase_value = value ? checkedNumber(value.value, "purchase_value", invalid) : 0;
  return result;
}

/** Legacy combined value kept for daily_metrics.conversions (dashboards). Audits use metaResults. */
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

const CAMPAIGN_FIELDS = "id,name,objective,effective_status,status,daily_budget,lifetime_budget,bid_strategy,buying_type,start_time,stop_time";

function toCampaignRecord(row: Record<string, unknown>, account: SyncAccount, capturedAt: string): CampaignRecord {
  const divisor = ZERO_DECIMAL.has(account.currency ?? "") ? 1 : 100;
  const hasDaily = row.daily_budget !== undefined && row.daily_budget !== null && row.daily_budget !== "";
  const hasLifetime = row.lifetime_budget !== undefined && row.lifetime_budget !== null && row.lifetime_budget !== "" && toNumber(row.lifetime_budget) > 0;
  return {
    external_id: row.id as string,
    name: typeof row.name === "string" ? row.name : null,
    objective: typeof row.objective === "string" ? row.objective : null,
    status: typeof row.effective_status === "string" ? row.effective_status : null,
    daily_budget: hasDaily ? toNumber(row.daily_budget) / divisor : null,
    bid_strategy: typeof row.bid_strategy === "string" ? row.bid_strategy : null,
    channel_type: typeof row.buying_type === "string" ? row.buying_type : null,
    details: {
      serving_status: typeof row.status === "string" ? row.status : null,
      start: typeof row.start_time === "string" ? row.start_time : null,
      end: typeof row.stop_time === "string" ? row.stop_time : null,
      lifetime_budget: hasLifetime ? toNumber(row.lifetime_budget) / divisor : null,
      budget_level: hasDaily || hasLifetime ? "campaign" : "ad_set",
      budget_shared: false,
      captured_at: capturedAt,
    },
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

  /** Follows paging.next until it is absent or `limit` items were read; `complete` is false when a next page remains. */
  async function pages<T>(path: string, params: Record<string, string>, token: string, limit: number): Promise<{ items: T[]; complete: boolean }> {
    const items: T[] = [];
    let body = await call(path, params, token);
    for (;;) {
      items.push(...((body.data as T[]) ?? []));
      const next = (body.paging as { next?: string } | undefined)?.next;
      if (!next) return { items, complete: true };
      if (items.length >= limit) return { items, complete: false };
      // `next` already carries all parameters, including the token.
      const response = await fetcher(next);
      body = (await readJson(response)) as GraphError & Record<string, unknown>;
      if (!response.ok || body.error) throw metaError(response.status, body);
    }
  }

  /** All pages or an "incomplete" error: never a silently truncated result. */
  async function paged<T>(path: string, params: Record<string, string>, token: string, limit = MAX_METRIC_ROWS): Promise<T[]> {
    const { items, complete } = await pages<T>(path, params, token, limit);
    if (!complete) throw new ProviderError("incomplete", `Meta returned more than ${limit} rows; the result was not read completely.`, `meta rows>${limit}`);
    return items;
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

  const systemUser = Boolean(config.loginConfigId);

  /** Server-side /debug_token with the app access token; the token is never logged. */
  async function inspectToken(accessToken: string): Promise<MetaTokenGrant> {
    const body = await call("/debug_token", {
      input_token: accessToken,
      access_token: `${config.appId}|${config.appSecret}`,
    });
    return evaluateDebugToken(body.data as DebugTokenData | undefined, config.appId);
  }

  function toDiscovered(row: Record<string, unknown>, clientBusinessId: string | null): DiscoveredAccount {
    return {
      external_account_id: `act_${row.account_id as string}`,
      account_name: typeof row.name === "string" ? row.name : null,
      currency: typeof row.currency === "string" ? row.currency : null,
      timezone: typeof row.timezone_name === "string" ? row.timezone_name : null,
      status: accountStatus(row.account_status),
      metadata: clientBusinessId
        ? { granted_via: "business_login", client_business_id: clientBusinessId }
        : {},
    };
  }

  /** Reads exactly the granted ad accounts, one by one; nothing else is listed. */
  async function grantedAccounts(accessToken: string): Promise<DiscoveredAccount[]> {
    const grant = await inspectToken(accessToken);
    const me = await call("/me", { fields: "client_business_id" }, accessToken);
    const clientBusinessId = graphId(me.client_business_id);
    const found: DiscoveredAccount[] = [];
    for (const id of grant.adAccountIds) {
      let row: Record<string, unknown>;
      try {
        row = await call(`/act_${id}`, { fields: ACCOUNT_FIELDS }, accessToken);
      } catch (error) {
        // A granted account that is no longer readable is skipped, not guessed.
        if (error instanceof ProviderError && error.code === "permission_denied") continue;
        throw error;
      }
      // Keep the account only when Meta returns the exact account that was granted.
      if (row.account_id !== id || row.id !== `act_${id}`) continue;
      found.push(toDiscovered(row, clientBusinessId));
    }
    return found;
  }

  return {
    provider: "meta",

    authorizeUrl(state) {
      const url = new URL(`https://www.facebook.com/${config.apiVersion}/dialog/oauth`);
      url.searchParams.set("client_id", config.appId);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("response_type", "code");
      if (systemUser) {
        // Facebook Login for Business, system user access token configuration.
        url.searchParams.set("config_id", config.loginConfigId!);
        url.searchParams.set("override_default_response_type", "true");
      } else {
        url.searchParams.set("scope", META_SCOPES.join(","));
      }
      return url.toString();
    },

    async exchangeCode(code) {
      if (systemUser) {
        // One server-side code exchange. System user tokens are not user
        // tokens: no fb_exchange_token swap and no /me/permissions.
        const issued = await exchange({ redirect_uri: config.redirectUri, code });
        const grant = await inspectToken(issued.accessToken);
        return { accessToken: issued.accessToken, refreshToken: null, expiresAt: grant.expiresAt, scopes: grant.scopes };
      }
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
      if (systemUser) {
        // /me is the app-scoped system user, not a person. The connection is
        // identified by the client's business portfolio.
        const body = await call("/me", { fields: "id,name,client_business_id" }, accessToken);
        const business = graphId(body.client_business_id);
        return {
          id: business,
          name: business ? `Meta business ${business}` : null,
        };
      }
      const body = await call("/me", { fields: "id,name" }, accessToken);
      return { id: typeof body.id === "string" ? body.id : null, name: typeof body.name === "string" ? body.name : null };
    },

    async listAccounts(accessToken) {
      if (systemUser) return grantedAccounts(accessToken);
      const { items: rows } = await pages<Record<string, unknown>>(
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
      // Campaign fields from the Marketing API Campaign reference. start_time
      // and stop_time are read-only at campaign level (merged from ad sets).
      // A campaign budget (daily or lifetime) means Advantage campaign budget;
      // without one, budgets live on the ad sets.
      const rows = await paged<Record<string, unknown>>(
        `/${account.external_account_id}/campaigns`,
        { fields: CAMPAIGN_FIELDS, limit: "200" },
        accessToken,
        5000,
      );
      const capturedAt = new Date().toISOString();
      return rows.filter((row) => typeof row.id === "string").map((row) => toCampaignRecord(row, account, capturedAt));
    },

    async fetchCampaignsById(accessToken, account, ids): Promise<CampaignRecord[]> {
      // Campaigns with insights in the window that /campaigns did not list
      // (e.g. deleted). Read one by one; a campaign Meta no longer returns
      // stays unresolved and the sync stores it as a placeholder.
      const capturedAt = new Date().toISOString();
      const records: CampaignRecord[] = [];
      for (const id of [...new Set(ids)].filter((value) => /^\d{1,25}$/.test(value)).slice(0, 200)) {
        try {
          const row = await call(`/${id}`, { fields: `${CAMPAIGN_FIELDS},account_id` }, accessToken);
          if (typeof row.account_id === "string" && `act_${row.account_id}` !== account.external_account_id) continue;
          if (typeof row.id === "string") records.push(toCampaignRecord(row, account, capturedAt));
        } catch (error) {
          if (error instanceof ProviderError && error.code === "auth_expired") throw error;
        }
      }
      return records;
    },

    async fetchMetrics(accessToken, account, since, until): Promise<MetricRecord[]> {
      const params = (fields: string) => ({
        level: "campaign",
        time_increment: "1",
        time_range: JSON.stringify({ since, until }),
        fields,
        limit: "500",
      });
      // `clicks` is all clicks (likes, profile clicks, ...); link clicks are
      // inline_link_clicks and are stored separately in platform_metrics.
      const fields = "campaign_id,impressions,reach,clicks,inline_link_clicks,spend,actions,action_values,date_start";
      let rows: Array<Record<string, unknown>>;
      let reachAvailable = true;
      try {
        rows = await paged(`/${account.external_account_id}/insights`, params(fields), accessToken);
      } catch (error) {
        // Some API versions restrict `reach` with daily breakdowns; retry without it.
        if (!(error instanceof ProviderError) || error.code !== "provider_error") throw error;
        reachAvailable = false;
        rows = await paged(`/${account.external_account_id}/insights`, params(fields.replace("reach,", "")), accessToken);
      }
      return rows
        .filter((row) => typeof row.campaign_id === "string" && typeof row.date_start === "string")
        .map((row) => {
          const invalid: string[] = reachAvailable ? [] : ["reach_unavailable"];
          const { conversions, conversionValue } = metaConversions(row.actions as ActionStat[], row.action_values as ActionStat[]);
          const record: MetricRecord = {
            external_campaign_id: row.campaign_id as string,
            date: row.date_start as string,
            impressions: Math.round(checkedNumber(row.impressions, "impressions", invalid)),
            reach: Math.round(checkedNumber(row.reach, "reach", invalid)),
            clicks: Math.round(checkedNumber(row.clicks, "clicks", invalid)),
            spend: checkedNumber(row.spend, "spend", invalid),
            conversions,
            conversion_value: conversionValue,
            platform_metrics: metaResults(row, invalid),
          };
          return invalid.length > 0 ? { ...record, invalid_fields: invalid } : record;
        });
    },

    async fetchAccountTotals(accessToken, account, since, until) {
      // Account-level totals for the whole window (time_increment defaults to all_days).
      const rows = await paged<Record<string, unknown>>(
        `/${account.external_account_id}/insights`,
        { level: "account", time_range: JSON.stringify({ since, until }), fields: "impressions,spend" },
        accessToken,
        10,
      );
      const invalid: string[] = [];
      const impressions = rows.reduce((sum, row) => sum + checkedNumber(row.impressions, "impressions", invalid), 0);
      const spend = rows.reduce((sum, row) => sum + checkedNumber(row.spend, "spend", invalid), 0);
      if (invalid.length > 0) throw new ProviderError("incomplete", "Meta returned non-numeric account totals.");
      return { impressions, spend };
    },

    async fetchDiagnostics(accessToken, account, since, until): Promise<AccountDiagnostics> {
      const divisor = ZERO_DECIMAL.has(account.currency ?? "") ? 1 : 100;
      const id = account.external_account_id;
      const money = (value: unknown) => (value === undefined || value === null || value === "" ? null : toNumber(value) / divisor);
      const window = JSON.stringify({ since, until });
      const insightRow = (row: Record<string, unknown>) => {
        const invalid: string[] = [];
        return {
          impressions: checkedNumber(row.impressions, "impressions", invalid),
          spend: checkedNumber(row.spend, "spend", invalid),
          link_clicks: row.inline_link_clicks === undefined ? null : checkedNumber(row.inline_link_clicks, "inline_link_clicks", invalid),
          ...metaResults(row, invalid),
        };
      };
      const sections: AccountDiagnostics["sections"] = {
        // learning_stage_info is only returned for active ad sets, not for
        // Dynamic Creative ad sets, and not for every ad account (Meta docs).
        ad_sets: await diagnosticSection(async () => {
          const { items: rows, complete } = await pages<Record<string, unknown>>(
            `/${id}/adsets`,
            { fields: "id,campaign_id,effective_status,optimization_goal,billing_event,daily_budget,lifetime_budget,learning_stage_info,destination_type,is_dynamic_creative", limit: "200" },
            accessToken,
            1000,
          );
          return {
            truncated: !complete,
            rows: rows.map((row) => {
              const learning = (row.learning_stage_info ?? null) as Record<string, unknown> | null;
              return {
                id: typeof row.id === "string" ? row.id : null,
                campaign_id: typeof row.campaign_id === "string" ? row.campaign_id : null,
                effective_status: typeof row.effective_status === "string" ? row.effective_status : null,
                optimization_goal: typeof row.optimization_goal === "string" ? row.optimization_goal : null,
                billing_event: typeof row.billing_event === "string" ? row.billing_event : null,
                daily_budget: money(row.daily_budget),
                lifetime_budget: money(row.lifetime_budget),
                destination_type: typeof row.destination_type === "string" ? row.destination_type : null,
                is_dynamic_creative: typeof row.is_dynamic_creative === "boolean" ? row.is_dynamic_creative : null,
                learning_status: learning && typeof learning.status === "string" ? learning.status : null,
                learning_conversions: learning && learning.conversions !== undefined ? toNumber(learning.conversions) : null,
              };
            }),
          };
        }),
        ads: await diagnosticSection(async () => {
          const { items: rows, complete } = await pages<Record<string, unknown>>(`/${id}/ads`, { fields: "id,campaign_id,adset_id,effective_status", limit: "200" }, accessToken, 2000);
          return {
            truncated: !complete,
            rows: rows.map((row) => ({
              campaign_id: typeof row.campaign_id === "string" ? row.campaign_id : null,
              effective_status: typeof row.effective_status === "string" ? row.effective_status : null,
            })),
          };
        }),
        // The adspixels edge documents no required permission; a refusal is
        // recorded as unavailable.
        pixels: await diagnosticSection(async () => {
          const { items: rows, complete } = await pages<Record<string, unknown>>(`/${id}/adspixels`, { fields: "id,name,last_fired_time,is_unavailable", limit: "50" }, accessToken, 50);
          return {
            truncated: !complete,
            rows: rows.map((row) => ({
              id: typeof row.id === "string" ? row.id : null,
              name: typeof row.name === "string" ? row.name : null,
              last_fired_time: typeof row.last_fired_time === "string" ? row.last_fired_time : null,
              is_unavailable: typeof row.is_unavailable === "boolean" ? row.is_unavailable : null,
            })),
          };
        }),
        // Documented breakdown combinations: "publisher_platform, platform_position" and "age, gender".
        placements: await diagnosticSection(async () => {
          const { items: rows, complete } = await pages<Record<string, unknown>>(
            `/${id}/insights`,
            { level: "account", time_range: window, breakdowns: "publisher_platform,platform_position", fields: "impressions,spend,inline_link_clicks,actions,action_values", limit: "500" },
            accessToken,
            500,
          );
          return {
            truncated: !complete,
            rows: rows.map((row) => ({
              publisher_platform: typeof row.publisher_platform === "string" ? row.publisher_platform : null,
              platform_position: typeof row.platform_position === "string" ? row.platform_position : null,
              ...insightRow(row),
            })),
          };
        }),
        audiences: await diagnosticSection(async () => {
          const { items: rows, complete } = await pages<Record<string, unknown>>(
            `/${id}/insights`,
            { level: "account", time_range: window, breakdowns: "age,gender", fields: "impressions,spend,inline_link_clicks,actions,action_values", limit: "500" },
            accessToken,
            500,
          );
          return {
            truncated: !complete,
            rows: rows.map((row) => ({
              age: typeof row.age === "string" ? row.age : null,
              gender: typeof row.gender === "string" ? row.gender : null,
              ...insightRow(row),
            })),
          };
        }),
        // Creative-level performance: ad-level totals for the window.
        ad_performance: await diagnosticSection(async () => {
          const { items: rows, complete } = await pages<Record<string, unknown>>(
            `/${id}/insights`,
            { level: "ad", time_range: window, fields: "ad_id,ad_name,campaign_id,impressions,reach,spend,inline_link_clicks,actions,action_values", limit: "500" },
            accessToken,
            2000,
          );
          return {
            truncated: !complete,
            rows: rows.map((row) => ({
              ad_id: typeof row.ad_id === "string" ? row.ad_id : null,
              ad_name: typeof row.ad_name === "string" ? row.ad_name : null,
              campaign_id: typeof row.campaign_id === "string" ? row.campaign_id : null,
              reach: row.reach === undefined ? null : toNumber(row.reach),
              ...insightRow(row),
            })),
          };
        }),
      };
      return { provider: "meta", window: { since, until }, captured_at: new Date().toISOString(), sections };
    },

    async revoke(accessToken) {
      // Best effort. For system user tokens Meta documents removal by the
      // client (Business Settings > Integrations > Connected apps); the caller
      // deletes the stored token from Vault either way.
      await call("/me/permissions", {}, accessToken, "DELETE");
    },
  };
}
