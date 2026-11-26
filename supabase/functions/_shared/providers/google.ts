// Google Ads API client (REST). OAuth 2.0 with PKCE and offline access. API
// access levels belong to the Google Cloud project that owns the OAuth client
// (developer tokens were retired on 9 September 2026, so none is sent). Client
// accounts managed through a manager (MCC) need the manager id as
// login-customer-id.

import {
  type AccountDiagnostics,
  type AdProvider,
  type CampaignDetails,
  type CampaignRecord,
  checkedNumber,
  diagnosticSection,
  MAX_METRIC_ROWS,
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
  // A Test-access Cloud project calling a production account: v25 and later
  // report CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION, v24 and earlier
  // ACTION_NOT_PERMITTED. The DEVELOPER_TOKEN_* reasons predate the sunset.
  const access = /CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION|ACTION_NOT_PERMITTED|DEVELOPER_TOKEN_NOT_APPROVED|DEVELOPER_TOKEN_PROHIBITED/.exec(text);
  if (access) {
    return new ProviderError(
      "permission_denied",
      "The Google Cloud project used for Google Ads does not have production Google Ads API access. Request Explorer or Basic access for the project on the Google Ads API Overview page in Google Cloud Console.",
      `${detail} ${access[0]}`,
    );
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

const CAMPAIGN_SELECT =
  "SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, campaign.primary_status, " +
  "campaign.primary_status_reasons, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, " +
  "campaign.bidding_strategy_type, campaign.start_date_time, campaign.end_date_time, campaign_budget.id, " +
  "campaign_budget.amount_micros, campaign_budget.total_amount_micros, campaign_budget.period, " +
  "campaign_budget.explicitly_shared, campaign_budget.reference_count FROM campaign";

function toCampaignRecord(row: SearchRow, capturedAt: string): CampaignRecord {
  const campaign = row.campaign ?? {};
  const budget = row.campaignBudget;
  const reasons = Array.isArray(campaign.primaryStatusReasons)
    ? (campaign.primaryStatusReasons as unknown[]).filter((reason): reason is string => typeof reason === "string")
    : [];
  const details: CampaignDetails = {
    channel_sub_type: text(campaign.advertisingChannelSubType),
    serving_status: text(campaign.servingStatus),
    primary_status: text(campaign.primaryStatus),
    primary_status_reasons: reasons,
    start: text(campaign.startDateTime),
    end: text(campaign.endDateTime),
    budget_id: budget?.id === undefined ? null : String(budget.id),
    budget_shared: typeof budget?.explicitlyShared === "boolean" ? budget.explicitlyShared : null,
    budget_period: text(budget?.period),
    budget_reference_count: budget?.referenceCount === undefined ? null : toNumber(budget.referenceCount),
    lifetime_budget: budget?.totalAmountMicros === undefined ? null : microsToUnits(budget.totalAmountMicros),
    captured_at: capturedAt,
  };
  return {
    external_id: String(campaign.id),
    name: text(campaign.name),
    objective: text(campaign.advertisingChannelType),
    status: text(campaign.status),
    daily_budget: budget?.amountMicros === undefined ? null : microsToUnits(budget.amountMicros),
    bid_strategy: text(campaign.biddingStrategyType),
    channel_type: text(campaign.advertisingChannelType),
    details,
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A metric that may legitimately be absent (e.g. impression share not reported). */
function nullableNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

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
      "Content-Type": "application/json",
    };
    if (loginCustomerId) result["login-customer-id"] = loginCustomerId;
    return result;
  }

  /**
   * Reads result pages (Search returns fixed pages of up to 10,000 rows) until
   * no next_page_token remains or `limit` rows were read. `complete` is false
   * when a page token is left, i.e. the result was cut off.
   */
  async function searchPages(accessToken: string, customerId: string, query: string, loginCustomerId: string | undefined, limit: number) {
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
    return { rows, complete: !pageToken };
  }

  /** All pages or an "incomplete" error: never a silently truncated result. */
  async function search(accessToken: string, customerId: string, query: string, loginCustomerId?: string, limit = MAX_METRIC_ROWS) {
    const { rows, complete } = await searchPages(accessToken, customerId, query, loginCustomerId, limit);
    if (!complete) {
      throw new ProviderError("incomplete", `Google Ads returned more than ${limit} rows; the result was not read completely.`, `google rows>${limit}`);
    }
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
          const { rows: clients } = await searchPages(
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
      // Fields checked against the v24 and v26 field references (campaign and
      // the attributed campaign_budget resource). campaign.start_date/end_date
      // do not exist; start_date_time/end_date_time are in the customer's time
      // zone ("yyyy-MM-dd HH:mm:ss"). Removed campaigns are fetched by id when
      // they still have metrics in the sync window (fetchCampaignsById).
      const rows = await search(accessToken, account.external_account_id, `${CAMPAIGN_SELECT} WHERE campaign.status != 'REMOVED'`, loginId(account));
      const capturedAt = new Date().toISOString();
      return rows.filter((row) => row.campaign?.id !== undefined).map((row) => toCampaignRecord(row, capturedAt));
    },

    async fetchCampaignsById(accessToken, account, ids): Promise<CampaignRecord[]> {
      const valid = [...new Set(ids)].filter((id) => /^\d{1,19}$/.test(id));
      const capturedAt = new Date().toISOString();
      const records: CampaignRecord[] = [];
      for (let index = 0; index < valid.length; index += 500) {
        const chunk = valid.slice(index, index + 500);
        // GAQL has no OR; IN takes a number list. No status filter: removed campaigns are included.
        const rows = await search(accessToken, account.external_account_id, `${CAMPAIGN_SELECT} WHERE campaign.id IN (${chunk.join(",")})`, loginId(account));
        records.push(...rows.filter((row) => row.campaign?.id !== undefined).map((row) => toCampaignRecord(row, capturedAt)));
      }
      return records;
    },

    async fetchAccountTotals(accessToken, account, since, until) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
        throw new ProviderError("provider_error", "Invalid sync window.");
      }
      // Unsegmented (segments.date only in WHERE): one row with the window totals.
      const rows = await search(
        accessToken,
        account.external_account_id,
        `SELECT metrics.impressions, metrics.cost_micros FROM customer WHERE segments.date BETWEEN '${since}' AND '${until}'`,
        loginId(account),
      );
      const invalid: string[] = [];
      const impressions = rows.reduce((sum, row) => sum + checkedNumber(row.metrics?.impressions, "impressions", invalid), 0);
      const spend = rows.reduce((sum, row) => sum + checkedNumber(row.metrics?.costMicros, "cost_micros", invalid), 0) / 1_000_000;
      if (invalid.length > 0) throw new ProviderError("incomplete", "Google Ads returned non-numeric account totals.");
      return { impressions, spend };
    },

    async fetchMetrics(accessToken, account, since, until): Promise<MetricRecord[]> {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
        throw new ProviderError("provider_error", "Invalid sync window.");
      }
      const rows = await search(
        accessToken,
        account.external_account_id,
        // No status filter: a campaign removed after the window still has history.
        `SELECT campaign.id, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`,
        loginId(account),
      );
      // Google documents that rows whose selected metrics are all zero are not
      // returned when segmenting, so an absent day in a completely read window
      // is a day without reported delivery (the sync also reconciles totals).
      return rows
        .filter((row) => row.campaign?.id !== undefined && typeof row.segments?.date === "string")
        .map((row) => {
          const invalid: string[] = [];
          const metrics = row.metrics ?? {};
          const record: MetricRecord = {
            external_campaign_id: String(row.campaign?.id),
            date: row.segments?.date as string,
            impressions: Math.round(checkedNumber(metrics.impressions, "impressions", invalid)),
            reach: 0, // Not reported per campaign/day by Google Ads.
            clicks: Math.round(checkedNumber(metrics.clicks, "clicks", invalid)),
            spend: checkedNumber(metrics.costMicros, "cost_micros", invalid) / 1_000_000,
            conversions: checkedNumber(metrics.conversions, "conversions", invalid),
            conversion_value: checkedNumber(metrics.conversionsValue, "conversions_value", invalid),
          };
          return invalid.length > 0 ? { ...record, invalid_fields: invalid } : record;
        });
    },

    async fetchDiagnostics(accessToken, account, since, until): Promise<AccountDiagnostics> {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
        throw new ProviderError("provider_error", "Invalid diagnostics window.");
      }
      const id = account.external_account_id;
      const login = loginId(account);
      const during = `segments.date BETWEEN '${since}' AND '${until}'`;
      // Diagnostics read at most `limit` rows; a remaining page token or a
      // full LIMIT marks the section as truncated (reported, never zero).
      const run = (query: string, map: (row: SearchRow) => Record<string, unknown>, limit: number) =>
        diagnosticSection(async () => {
          const { rows, complete } = await searchPages(accessToken, id, query, login, limit);
          return { rows: rows.slice(0, limit).map(map), truncated: !complete || rows.length >= limit };
        });
      // Every field below was checked against the v24 field reference.
      const sections: AccountDiagnostics["sections"] = {
        conversion_actions: await run(
          "SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type, " +
            "conversion_action.category, conversion_action.origin, conversion_action.primary_for_goal, " +
            "conversion_action.include_in_conversions_metric, conversion_action.counting_type, " +
            "conversion_action.value_settings.default_value, conversion_action.value_settings.always_use_default_value " +
            "FROM conversion_action WHERE conversion_action.status != 'REMOVED'",
          (row) => {
            const action = row.conversionAction ?? {};
            const value = (action.valueSettings ?? {}) as Record<string, unknown>;
            return {
              id: action.id === undefined ? null : String(action.id),
              name: text(action.name),
              status: text(action.status),
              type: text(action.type),
              category: text(action.category),
              origin: text(action.origin),
              primary_for_goal: typeof action.primaryForGoal === "boolean" ? action.primaryForGoal : null,
              include_in_conversions_metric: typeof action.includeInConversionsMetric === "boolean" ? action.includeInConversionsMetric : null,
              counting_type: text(action.countingType),
              default_value: nullableNumber(value.defaultValue),
              always_use_default_value: typeof value.alwaysUseDefaultValue === "boolean" ? value.alwaysUseDefaultValue : null,
            };
          },
          500,
        ),
        // Impression share is a ratio, so it is read for the whole window
        // (segments.date only in WHERE); daily values cannot be summed.
        search_impression_share: await run(
          "SELECT campaign.id, metrics.impressions, metrics.search_impression_share, " +
            "metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share " +
            `FROM campaign WHERE campaign.advertising_channel_type = 'SEARCH' AND campaign.status != 'REMOVED' AND ${during}`,
          (row) => ({
            campaign_id: String(row.campaign?.id ?? ""),
            impressions: toNumber(row.metrics?.impressions),
            search_impression_share: nullableNumber(row.metrics?.searchImpressionShare),
            search_budget_lost_impression_share: nullableNumber(row.metrics?.searchBudgetLostImpressionShare),
            search_rank_lost_impression_share: nullableNumber(row.metrics?.searchRankLostImpressionShare),
          }),
          500,
        ),
        ads: await run(
          "SELECT campaign.id, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.status, ad_group_ad.ad_strength, " +
            "ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status " +
            "FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED' AND campaign.status != 'REMOVED'",
          (row) => {
            const ad = row.adGroupAd ?? {};
            const policy = (ad.policySummary ?? {}) as Record<string, unknown>;
            const inner = (ad.ad ?? {}) as Record<string, unknown>;
            return {
              campaign_id: String(row.campaign?.id ?? ""),
              ad_type: text(inner.type),
              status: text(ad.status),
              ad_strength: text(ad.adStrength),
              approval_status: text(policy.approvalStatus),
              review_status: text(policy.reviewStatus),
            };
          },
          5000,
        ),
        keywords: await run(
          "SELECT campaign.id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, " +
            "ad_group_criterion.quality_info.quality_score, ad_group_criterion.quality_info.creative_quality_score, " +
            "ad_group_criterion.quality_info.post_click_quality_score, ad_group_criterion.quality_info.search_predicted_ctr, " +
            "metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM keyword_view " +
            `WHERE ad_group_criterion.status = 'ENABLED' AND ad_group_criterion.negative = FALSE AND ${during} ` +
            "ORDER BY metrics.cost_micros DESC LIMIT 300",
          (row) => {
            const criterion = row.adGroupCriterion ?? {};
            const keyword = (criterion.keyword ?? {}) as Record<string, unknown>;
            const quality = (criterion.qualityInfo ?? {}) as Record<string, unknown>;
            return {
              campaign_id: String(row.campaign?.id ?? ""),
              text: text(keyword.text),
              match_type: text(keyword.matchType),
              quality_score: nullableNumber(quality.qualityScore),
              creative_quality: text(quality.creativeQualityScore),
              landing_page_quality: text(quality.postClickQualityScore),
              expected_ctr: text(quality.searchPredictedCtr),
              impressions: toNumber(row.metrics?.impressions),
              clicks: toNumber(row.metrics?.clicks),
              cost: microsToUnits(row.metrics?.costMicros),
              conversions: toNumber(row.metrics?.conversions),
            };
          },
          300,
        ),
        // search_term_view excludes Performance Max (Google documents
        // campaign_search_term_view for that), so this covers Search/Shopping.
        search_terms: await run(
          "SELECT campaign.id, search_term_view.search_term, search_term_view.status, metrics.impressions, " +
            "metrics.clicks, metrics.cost_micros, metrics.conversions FROM search_term_view " +
            `WHERE metrics.cost_micros > 0 AND ${during} ORDER BY metrics.cost_micros DESC LIMIT 300`,
          (row) => ({
            campaign_id: String(row.campaign?.id ?? ""),
            search_term: text(row.searchTermView?.searchTerm),
            status: text(row.searchTermView?.status),
            impressions: toNumber(row.metrics?.impressions),
            clicks: toNumber(row.metrics?.clicks),
            cost: microsToUnits(row.metrics?.costMicros),
            conversions: toNumber(row.metrics?.conversions),
          }),
          300,
        ),
        // Performance Max search terms (campaign_search_term_view, v24 and v26).
        // Keyword-related segments would exclude PMax data, so none are used.
        pmax_search_terms: await run(
          "SELECT campaign.id, campaign_search_term_view.search_term, metrics.impressions, metrics.clicks, " +
            "metrics.cost_micros, metrics.conversions FROM campaign_search_term_view " +
            `WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX' AND metrics.cost_micros > 0 AND ${during} ` +
            "ORDER BY metrics.cost_micros DESC LIMIT 300",
          (row) => ({
            campaign_id: String(row.campaign?.id ?? ""),
            search_term: text(row.campaignSearchTermView?.searchTerm),
            impressions: toNumber(row.metrics?.impressions),
            clicks: toNumber(row.metrics?.clicks),
            cost: microsToUnits(row.metrics?.costMicros),
            conversions: toNumber(row.metrics?.conversions),
          }),
          300,
        ),
        // Performance Max has no ad_group_ad; ad strength is on asset_group.
        asset_groups: await run(
          "SELECT campaign.id, asset_group.id, asset_group.name, asset_group.status, asset_group.primary_status, asset_group.ad_strength " +
            "FROM asset_group WHERE asset_group.status != 'REMOVED' AND campaign.status != 'REMOVED'",
          (row) => ({
            campaign_id: String(row.campaign?.id ?? ""),
            asset_group_id: row.assetGroup?.id === undefined ? null : String(row.assetGroup.id),
            name: text(row.assetGroup?.name),
            status: text(row.assetGroup?.status),
            primary_status: text(row.assetGroup?.primaryStatus),
            ad_strength: text(row.assetGroup?.adStrength),
          }),
          2000,
        ),
      };
      return { provider: "google", window: { since, until }, captured_at: new Date().toISOString(), sections };
    },

    async revoke(accessToken, refreshToken) {
      await fetcher(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken ?? accessToken)}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    },
  };
}
