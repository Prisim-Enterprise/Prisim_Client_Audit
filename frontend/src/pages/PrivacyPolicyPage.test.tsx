import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { renderPrivacyPolicyMarkup } from "../prerender/privacyPolicy";
import { PRISIM_REGISTERED_ADDRESS, PRIVACY_CONTACT_EMAIL } from "./PrivacyPolicyPage";

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

describe("public privacy policy", () => {
  it("renders at /privacy-policy without signing in", async () => {
    window.history.pushState({}, "", "/privacy-policy");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Privacy Policy" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/privacy-policy");
    expect(screen.queryByText(/Restoring your secure session/)).not.toBeInTheDocument();
  });

  it("shows the confirmed PRISIM details and no placeholders", async () => {
    window.history.pushState({}, "", "/privacy-policy");
    const { container } = render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Privacy Policy" });
    const text = container.textContent ?? "";
    expect(text).toContain(PRISIM_REGISTERED_ADDRESS);
    expect(text).toContain("Mathikere, Bangalore - 560054");
    expect(screen.getAllByRole("link", { name: PRIVACY_CONTACT_EMAIL })[0]).toHaveAttribute("href", "mailto:info@prisim.co.in");
    expect(text).not.toMatch(/\[[A-Z _]+\]|placeholder|TBD|TODO|lorem/i);
  });

  it("prerenders the complete policy as static HTML without scripts", () => {
    const markup = renderPrivacyPolicyMarkup();
    expect(markup).toContain("<h1");
    expect(markup).toContain(PRISIM_REGISTERED_ADDRESS);
    expect(markup).toContain('href="mailto:info@prisim.co.in"');
    expect(markup).toContain('href="/login"');
    for (const permission of ["ads_read", "business_management", "pages_show_list", "pages_read_engagement"]) {
      expect(markup).toContain(permission);
    }
    expect(markup).toContain('id="contact"');
    expect(markup).not.toContain("<script");
  });

  it("describes retention without fixed overall periods or promises of immediate deletion", async () => {
    window.history.pushState({}, "", "/privacy-policy");
    const { container } = render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Privacy Policy" });
    const retention = container.querySelector("#retention")?.textContent ?? "";
    expect(retention).toContain("does not expire automatically");
    expect(retention).toContain("append-only");
    expect(retention).toMatch(/backups and logs maintained by our infrastructure providers/);
    expect(retention).toMatch(/approximately 14 days/);
    expect(retention).toMatch(/approximately 90\s+days/);
    expect(retention).toMatch(/approximately 30 days/);
    expect(retention).toMatch(/no\s+automatic expiry/);
    expect(retention).toMatch(/does not automatically delete historical campaign and performance data, audits,\s+reports/);
    expect(container.textContent).not.toMatch(/immediately delete|deleted immediately|permanently erased/i);
  });
});
