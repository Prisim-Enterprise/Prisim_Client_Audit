import { summarizePlatforms } from "@functions/_shared/analytics/platform.ts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CampaignPerformance } from "../../lib/api/types";
import { CampaignTable } from "./PerformancePanel";
import { PlatformSummaries } from "./PlatformSummaries";

function campaign(overrides: Partial<CampaignPerformance>): CampaignPerformance {
  return {
    campaign_id: overrides.campaign_name ?? "c", ad_account_id: "a", provider: "google", account_name: null, external_campaign_id: "1", campaign_name: "c",
    objective: null, campaign_status: "ACTIVE", channel_type: null, bid_strategy: null, daily_budget: null, currency: "INR",
    impressions: 10000, reach: 0, clicks: 300, spend: 3000, conversions: 20, conversion_value: 0, active_days: 30,
    metric_rows: 30, platform_metric_rows: 0, platform_metrics: null,
    ...overrides,
  };
}

const google = campaign({ campaign_name: "Search brand", conversions: 20, conversion_value: 6000 });
const metaLeads = campaign({ campaign_name: "Meta leads", provider: "meta", objective: "OUTCOME_LEADS", clicks: 500, conversions: 99, platform_metric_rows: 30, platform_metrics: { link_clicks: 200, leads: 12, purchases: 4, purchase_value: 300 } });
const metaLegacy = campaign({ campaign_name: "Meta sales (old data)", provider: "meta", objective: "OUTCOME_SALES", conversions: 7, platform_metric_rows: 0, platform_metrics: null });

describe("platform-specific analytics display", () => {
  afterEach(cleanup);

  it("summary cards are per platform and show Meta results by objective", () => {
    render(<PlatformSummaries summaries={summarizePlatforms([google, metaLeads])} />);
    const googleCard = screen.getByTestId("platform-summary-google");
    const metaCard = screen.getByTestId("platform-summary-meta");
    expect(within(googleCard).getByText("Conversions")).toBeInTheDocument();
    expect(within(googleCard).getByText("20")).toBeInTheDocument();
    expect(within(metaCard).getByText("Link clicks")).toBeInTheDocument();
    expect(within(metaCard).getByText("Leads")).toBeInTheDocument();
    expect(within(metaCard).getByText("12")).toBeInTheDocument();
    expect(within(metaCard).queryByText("Conversions")).not.toBeInTheDocument();
    expect(screen.queryByText("119")).not.toBeInTheDocument(); // 20 + 99 combined
    expect(screen.queryByText("32")).not.toBeInTheDocument(); // 20 + 12 combined
  });

  it("historical Meta campaigns show Unavailable instead of zero", () => {
    render(<PlatformSummaries summaries={summarizePlatforms([metaLegacy])} />);
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(screen.getByText(/without link-click and result data/)).toBeInTheDocument();
  });

  it("campaign rows use each platform's own metrics", () => {
    render(<CampaignTable campaigns={[google, metaLeads, metaLegacy]} />);
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]).getByText("20 conversions")).toBeInTheDocument();
    expect(within(rows[1]).getByText("2.00x")).toBeInTheDocument(); // Google ROAS
    expect(within(rows[2]).getByText("12 leads")).toBeInTheDocument();
    expect(within(rows[2]).getByText("2.00%")).toBeInTheDocument(); // link CTR 200 / 10000, not all-click 5%
    expect(within(rows[2]).queryByText("5.00%")).not.toBeInTheDocument();
    expect(within(rows[3]).getAllByText("Unavailable").length).toBeGreaterThanOrEqual(3);
    expect(within(rows[3]).queryByText("7 conversions")).not.toBeInTheDocument();
  });
});
