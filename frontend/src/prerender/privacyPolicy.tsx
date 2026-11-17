import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { PrivacyPolicyPage } from "../pages/PrivacyPolicyPage";

/**
 * Static HTML of the public privacy policy, written to dist/privacy-policy.html
 * at build time (scripts/prerender-privacy-policy.mjs) so the full policy is
 * readable without JavaScript, by crawlers and on direct navigation. The same
 * component also serves the in-app /privacy-policy route.
 */
export function renderPrivacyPolicyMarkup(): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/privacy-policy"]}>
      <PrivacyPolicyPage />
    </MemoryRouter>,
  );
}

export const PRIVACY_POLICY_TITLE = "Privacy Policy · PRISIM Client Audit Portal";
export const PRIVACY_POLICY_DESCRIPTION =
  "How PRISIM collects, uses, shares and retains information in the PRISIM Client Audit Portal, including Meta and Google advertising data.";
