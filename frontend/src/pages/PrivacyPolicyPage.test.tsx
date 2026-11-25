import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { renderPrivacyPolicyMarkup } from "../prerender/privacyPolicy";
import { PRISIM_ADDRESS_LINES, PRIVACY_CONTACT_EMAIL } from "./PrivacyPolicyPage";

// Signed-out visitor whose session is still being restored: protected routes
// would show a loading screen or redirect to /login. The policy must not.
vi.mock("../context/AuthProvider", () => ({
  useAuth: () => ({
    user: null,
    authLoading: true,
    contextLoading: false,
    context: null,
    contextError: null,
    memberships: [],
    demo: false,
    signOut: vi.fn(),
  }),
}));

afterEach(cleanup);

async function renderPolicy() {
  window.history.pushState({}, "", "/privacy-policy");
  const view = render(<App />);
  await screen.findByRole("heading", { level: 1, name: "Privacy Policy" });
  return view;
}

describe("public privacy policy", () => {
  it("renders at /privacy-policy without signing in", async () => {
    await renderPolicy();
    expect(window.location.pathname).toBe("/privacy-policy");
    expect(screen.queryByText(/Restoring your secure session/)).not.toBeInTheDocument();
  });

  it("has all 36 sections with linkable headings and a table of contents", async () => {
    const { container } = await renderPolicy();
    const headings = container.querySelectorAll("main section > h2");
    expect(headings).toHaveLength(36);
    const toc = screen.getByRole("navigation", { name: "Contents" });
    const links = toc.querySelectorAll("a");
    expect(links).toHaveLength(36);
    for (const link of links) {
      const id = link.getAttribute("href")!.slice(1);
      expect(container.querySelector(`section#${id}`)).not.toBeNull();
    }
    expect(container.textContent).toMatch(/Effective date:\s*17 November 2026/);
    expect(container.textContent).toMatch(/Last updated:\s*17 November 2026/);
  });

  it("shows the confirmed PRISIM details and no placeholders or invented roles", async () => {
    const { container } = await renderPolicy();
    const text = container.textContent ?? "";
    for (const line of PRISIM_ADDRESS_LINES) expect(text).toContain(line);
    expect(screen.getAllByRole("link", { name: PRIVACY_CONTACT_EMAIL })[0]).toHaveAttribute("href", "mailto:info@prisim.co.in");
    expect(text).not.toMatch(/\[[A-Z _]+\]|placeholder|TBD|TODO|lorem/i);
    expect(text).not.toMatch(/Data Protection Officer|Grievance Officer|\+91|telephone/i);
    expect(text).not.toMatch(/ISO 27001|SOC 2|certified|fully compliant|we guarantee|100% secure/i);
    expect(text).toContain("we cannot guarantee absolute security");
  });

  it("lists every Meta permission and the Google Limited Use statement", async () => {
    const { container } = await renderPolicy();
    const meta = container.querySelector("#meta")?.textContent ?? "";
    for (const permission of ["ads_read", "business_management", "pages_show_list", "pages_read_engagement"]) {
      expect(meta).toContain(permission);
    }
    expect(meta).toContain("does not currently use them to retrieve or store any Page");
    expect(container.querySelector("#google")?.textContent).toMatch(/Limited Use requirements/);
  });

  it("describes retention as implemented, without promising immediate deletion", async () => {
    const { container } = await renderPolicy();
    const retention = container.querySelector("#retention")?.textContent ?? "";
    expect(retention).toMatch(/approximately 14 days/);
    expect(retention).toMatch(/approximately 90 days/);
    expect(retention).toMatch(/approximately 30 days/);
    expect(retention).toMatch(/Activity \(audit\) log\s*No automatic expiry/);
    expect(retention).toMatch(/Disconnecting an advertising account does not delete them/);
    expect(container.querySelector("#deletion")?.textContent).toMatch(/does not delete data already synchronised/);
    expect(container.textContent).not.toMatch(/immediately delete|deleted immediately|permanently erased/i);
  });

  it("discloses that no self-service rights centre exists and gives the email route", async () => {
    const { container } = await renderPolicy();
    const requests = container.querySelector("#requests")?.textContent ?? "";
    expect(requests).toMatch(/does not yet have a self-service privacy or data-rights centre/);
    expect(requests).toContain(PRIVACY_CONTACT_EMAIL);
    expect(container.querySelector("#grievances")?.textContent).toMatch(/ninety days/);
  });

  it("prerenders the complete policy as static HTML without scripts", () => {
    const markup = renderPrivacyPolicyMarkup();
    expect(markup).toContain("<h1");
    for (const line of PRISIM_ADDRESS_LINES) expect(markup).toContain(line);
    expect(markup).toContain('href="mailto:info@prisim.co.in"');
    expect(markup).toContain('href="/login"');
    expect(markup).toContain('id="contact"');
    expect(markup).not.toContain("<script");
  });
});
