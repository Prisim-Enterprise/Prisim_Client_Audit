import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DemoRoot } from "./DemoRoot";
import { createDemoApi } from "./demo-api";
import { DEMO_TENANT_IDS } from "./fixtures";

afterEach(cleanup);

beforeEach(() => {
  window.history.pushState({}, "", "/");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }),
  });
});

async function choose(persona: RegExp) {
  render(<DemoRoot />);
  await userEvent.click(await screen.findByRole("button", { name: persona }));
}

describe("demo application", () => {
  it("labels synthetic data and lets staff review clients and audits", async () => {
    await choose(/PRISIM staff/);
    expect(await screen.findByText(/Good to see you, Asha/)).toBeInTheDocument();
    expect(screen.getByText(/DEMO MODE/)).toBeInTheDocument();
    expect(await screen.findByText("Onboarding audit")).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("link", { name: "Clients" })[0]);
    expect(await screen.findByRole("heading", { name: "Client organizations" })).toBeInTheDocument();
    expect(await screen.findByText("Harbor Realty (Demo)")).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("link", { name: "Audits" })[0]);
    await userEvent.click(await screen.findByRole("link", { name: "Onboarding audit" }));
    expect(await screen.findByText(/Not visible to the client/)).toBeInTheDocument();
    expect((await screen.findAllByText(/No conversions recorded/)).length).toBeGreaterThan(0);
  }, 20_000);

  it("shows the client owner their published audit and analytics", async () => {
    await choose(/Client owner/);
    expect(await screen.findByText(/Welcome, Rohan/)).toBeInTheDocument();
    expect(await screen.findByText("Q4 performance audit")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Team" }).length).toBeGreaterThan(0);

    await userEvent.click(screen.getAllByRole("link", { name: "Campaigns" })[0]);
    expect(await screen.findByRole("heading", { name: "Campaign analytics" })).toBeInTheDocument();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Teeth Whitening - Leads")).toBeInTheDocument();
  }, 20_000);

  it("gives viewers read-only account access without team management", async () => {
    await choose(/Client viewer/);
    expect(await screen.findByText(/Welcome, Meera/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Team" })).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("link", { name: "Ad accounts" })[0]);
    expect(await screen.findByText("Connected ad accounts")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Connect/ })).not.toBeInTheDocument();
  }, 20_000);
});

describe("core workflows", () => {
  it("client owner connects Meta through the OAuth callback and returns to account selection", async () => {
    await choose(/Client owner/);
    await userEvent.click((await screen.findAllByRole("link", { name: "Ad accounts" }))[0]);
    const connectButtons = await screen.findAllByRole("button", { name: /Connect/ });
    await waitFor(() => expect(connectButtons[0]).toBeEnabled());
    await userEvent.click(connectButtons[0]);
    expect(await screen.findByText(/Meta Ads connected/, {}, { timeout: 5000 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Choose ad accounts" }));
    expect(await screen.findByText("Meta account (Demo)")).toBeInTheDocument();
  }, 20_000);

  it("staff publish a reviewed audit and generate a shared PDF report", async () => {
    await choose(/PRISIM staff/);
    await userEvent.click((await screen.findAllByRole("link", { name: "Audits" }))[0]);
    await userEvent.click(await screen.findByRole("link", { name: "Onboarding audit" }));
    await userEvent.click(await screen.findByRole("button", { name: /Publish/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Publish to client" }));
    expect(await screen.findByText("This audit is visible to the client's users and can no longer be edited.")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /Generate & share with client/ }));
    const reportRow = await screen.findByText("Harbor Realty (Demo) - Onboarding audit", {}, { timeout: 8000 });
    expect(reportRow).toBeInTheDocument();
    expect(await screen.findAllByText("Shared with client")).not.toHaveLength(0);
  }, 30_000);
});

describe("demo API rules mirror the database", () => {
  const api = createDemoApi({ actorId: () => "actor", actorEmail: () => "actor@example.com" });

  it("keeps published audits immutable and gates report sharing on publication", async () => {
    const runs = await api.listAuditRuns(DEMO_TENANT_IDS.northwind);
    const published = runs.find((run) => run.status === "published")!;
    const [finding] = await api.listFindings(published.id);
    await expect(api.updateFinding(finding.id, { status: "dismissed" })).rejects.toThrow(/immutable/);
    await expect(api.deleteAuditRun(published.id)).rejects.toThrow(/archive/);

    const draft = (await api.listAuditRuns(DEMO_TENANT_IDS.harbor))[0];
    await expect(api.generateReport(draft.id, true)).rejects.toThrow(/Publish/);
    const { reportId } = await api.generateReport(draft.id, false);
    await expect(api.setReportVisibility(reportId, "client")).rejects.toThrow(/Publish/);
    await api.setAuditStatus(draft.id, "published");
    await api.setReportVisibility(reportId, "client");
    expect((await api.listReports(DEMO_TENANT_IDS.harbor)).find((report) => report.id === reportId)?.visibility).toBe("client");
  }, 20_000);

  it("protects the last owner", async () => {
    const [owner] = await api.listMembers(DEMO_TENANT_IDS.harbor);
    await expect(api.changeMemberRole(DEMO_TENANT_IDS.harbor, owner.user_id, "viewer")).rejects.toThrow(/owner/);
    await expect(api.deactivateMember(DEMO_TENANT_IDS.harbor, owner.user_id)).rejects.toThrow(/owner/);
  });
});
