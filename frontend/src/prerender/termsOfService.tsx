import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { TermsOfServicePage } from "../pages/TermsOfServicePage";

/**
 * Static HTML of the public terms of service, written to
 * dist/terms-of-service.html at build time (scripts/prerender-privacy-policy.mjs).
 * The same component also serves the in-app /terms-of-service route.
 */
export function renderTermsOfServiceMarkup(): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/terms-of-service"]}>
      <TermsOfServicePage />
    </MemoryRouter>,
  );
}

export const TERMS_OF_SERVICE_TITLE = "Terms of Service · PRISIM Client Audit Portal";
export const TERMS_OF_SERVICE_DESCRIPTION =
  "Terms that govern access to and use of the PRISIM Client Audit Portal.";
