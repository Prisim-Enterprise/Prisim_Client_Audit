import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { renderTermsOfServiceMarkup } from "../prerender/termsOfService";
import { PRISIM_ADDRESS_LINES, PRIVACY_CONTACT_EMAIL } from "./PrivacyPolicyPage";

// Signed-out visitor whose session is still being restored: the terms must
// render anyway, like the privacy policy.
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

async function renderTerms() {
  window.history.pushState({}, "", "/terms-of-service");
  const view = render(<App />);
  await screen.findByRole("heading", { level: 1, name: "Terms of Service" });
  return view;
}

describe("public terms of service", () => {
  it("renders at /terms-of-service without signing in", async () => {
    await renderTerms();
    expect(window.location.pathname).toBe("/terms-of-service");
    expect(screen.queryByText(/Restoring your secure session/)).not.toBeInTheDocument();
  });

  it("has a linked table of contents and dated sections", async () => {
    const { container } = await renderTerms();
    const links = screen.getByRole("navigation", { name: "Contents" }).querySelectorAll("a");
    expect(links).toHaveLength(container.querySelectorAll("main section > h2").length);
    for (const link of links) {
      expect(container.querySelector(`section#${link.getAttribute("href")!.slice(1)}`)).not.toBeNull();
    }
    expect(container.textContent).toMatch(/Effective date:\s*25 November 2026/);
  });

  it("shows the confirmed PRISIM details, links the privacy policy and has no placeholders", async () => {
    const { container } = await renderTerms();
    const text = container.textContent ?? "";
    for (const line of PRISIM_ADDRESS_LINES) expect(text).toContain(line);
    expect(screen.getAllByRole("link", { name: PRIVACY_CONTACT_EMAIL })[0]).toHaveAttribute("href", "mailto:info@prisim.co.in");
    expect(screen.getAllByRole("link", { name: "Privacy Policy" })[0]).toHaveAttribute("href", "/privacy-policy");
    expect(text).not.toMatch(/\[[A-Z _]+\]|placeholder|TBD|TODO|lorem/i);
    expect(container.querySelector("#integrations")?.textContent).toMatch(/only reads advertising data/);
  });

  it("prerenders as static HTML without scripts", () => {
    const markup = renderTermsOfServiceMarkup();
    expect(markup).toContain("<h1");
    expect(markup).toContain('href="mailto:info@prisim.co.in"');
    expect(markup).toContain('id="contact"');
    expect(markup).not.toContain("<script");
  });
});
