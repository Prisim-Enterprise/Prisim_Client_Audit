import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ScoreRing } from "../../components/charts/ScoreRing";
import type { AuditRun } from "../../lib/api/types";
import { PlatformScoreRings, platformScoresOf, RunScore, ScoreStatusBanner } from "./AuditComponents";

function run(overrides: Partial<AuditRun>): AuditRun {
  return {
    id: "r", tenant_id: "t", title: "Audit", period_start: "2026-10-26", period_end: "2026-11-24", status: "published",
    engine_version: "prisim-audit-2.1.0", overall_score: null, platform_scores: {}, category_scores: {}, kpis: {}, summary: null,
    ad_account_ids: [], reviewed_at: null, published_at: null, created_at: "2026-11-26T00:00:00Z", updated_at: "2026-11-26T00:00:00Z",
    ...overrides,
  };
}

const platforms = (google: { score: number | null; status: "scored" | "provisional" | "unscored" }, meta?: { score: number | null; status: "scored" | "provisional" | "unscored" }) => ({
  scoring: {
    status: "provisional" as const, overall: null, reason: "", method: "", severityPenalties: { critical: 35, high: 20, medium: 10, low: 4, info: 0 }, accounts: [],
    platforms: {
      google: { ...google, reason: google.status === "provisional" ? "Provisional: 80% of the period's days are known." : "No impressions or spend were recorded.", accounts: 1, scoredAccounts: google.score === null ? 0 : 1, comparable: true, weights: { tracking: 0.25, efficiency: 0.25, engagement: 0.15, structure: 0.1, budget: 0.15, trend: 0.1 }, caps: {} },
      ...(meta ? { meta: { ...meta, reason: "All accounts had sufficient evidence.", accounts: 1, scoredAccounts: 1, comparable: true, weights: { tracking: 0.2, efficiency: 0.25, engagement: 0.25, structure: 0.15, budget: 0.05, trend: 0.1 }, caps: {} } } : {}),
    },
  },
});

describe("score display", () => {
  afterEach(cleanup);

  it("Not scored never shows a number or a /100 scale", () => {
    render(<ScoreRing score={null} />);
    expect(screen.getAllByText("Not scored").length).toBeGreaterThan(0);
    expect(screen.queryByText("/ 100")).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("labels Final and Provisional scores", () => {
    const { unmount } = render(<ScoreRing score={82} status="scored" />);
    expect(screen.getByText("Final")).toBeInTheDocument();
    unmount();
    render(<ScoreRing score={82} status="provisional" />);
    expect(screen.getByText("Provisional")).toBeInTheDocument();
    expect(screen.getByText("82")).toBeInTheDocument();
  });

  it("shows Google and Meta separately and never a combined number", () => {
    const audit = run({ platform_scores: { google: 72, meta: 64 }, kpis: platforms({ score: 72, status: "provisional" }, { score: 64, status: "scored" }) });
    render(<RunScore run={audit} />);
    expect(screen.getByText(/Google/)).toBeInTheDocument();
    expect(screen.getByText(/Meta/)).toBeInTheDocument();
    expect(screen.getByText("Provisional")).toBeInTheDocument();
    expect(screen.queryByText("68")).not.toBeInTheDocument(); // (72 + 64) / 2
    render(<PlatformScoreRings run={audit} />);
    expect(screen.getAllByText("72").length).toBeGreaterThan(0);
    expect(screen.getAllByText("64").length).toBeGreaterThan(0);
  });

  it("an unscored published audit reads Not scored in tables, not 0", () => {
    render(<RunScore run={run({ kpis: platforms({ score: null, status: "unscored" }) })} />);
    expect(screen.getByText("Not scored")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("makes provisional and unscored status prominent with the reason", () => {
    const { unmount } = render(<ScoreStatusBanner run={run({ platform_scores: { google: 72 }, kpis: platforms({ score: 72, status: "provisional" }) })} />);
    expect(screen.getByRole("status")).toHaveTextContent(/Provisional score/);
    expect(screen.getByRole("status")).toHaveTextContent(/80% of the period's days are known/);
    unmount();
    render(<ScoreStatusBanner run={run({ kpis: platforms({ score: null, status: "unscored" }) })} />);
    expect(screen.getByRole("status")).toHaveTextContent(/Not scored/);
  });

  it("a Not scored audit with critical findings says it is not healthy", () => {
    const kpis = { ...platforms({ score: null, status: "unscored" }), findingCounts: { critical: 1, high: 2, medium: 0, low: 0, info: 0 } };
    render(<ScoreStatusBanner run={run({ kpis })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Not scored does not mean healthy: 1 critical and 2 high-priority findings need action");
  });

  it("final scores need no banner; pre-2.1 audits keep their stored platform scores", () => {
    const { container } = render(<ScoreStatusBanner run={run({ platform_scores: { google: 90 }, kpis: platforms({ score: 90, status: "scored" }) })} />);
    expect(container).toBeEmptyDOMElement();
    expect(platformScoresOf(run({ engine_version: "prisim-audit-1.0.0", overall_score: 81, platform_scores: { meta: 81 } }))).toEqual([{ provider: "meta", score: 81, status: "scored", reason: null }]);
  });
});
