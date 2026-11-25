import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Brand } from "../components/Brand";
import { PRISIM_ADDRESS_LINES, PRIVACY_CONTACT_EMAIL } from "./PrivacyPolicyPage";

/**
 * Public terms of service (no sign-in required): https://audit.prisim.co.in/terms-of-service
 *
 * Statements about how the portal works must match the implementation and the
 * privacy policy. A separate written agreement with a client takes precedence.
 */

export const TERMS_EFFECTIVE_DATE = "25 November 2026";
export const TERMS_LAST_UPDATED = "25 November 2026";

const SECTIONS = [
  ["acceptance", "Acceptance and who we are"],
  ["service", "The service"],
  ["accounts", "Accounts and eligibility"],
  ["security", "Account security"],
  ["authorisations", "Client authorisations"],
  ["integrations", "Meta and Google advertising integrations"],
  ["acceptable-use", "Acceptable use"],
  ["client-data", "Client data and privacy"],
  ["audits", "Audits, reports and recommendations"],
  ["ip", "Intellectual property"],
  ["confidentiality", "Confidentiality"],
  ["availability", "Availability and changes to the service"],
  ["fees", "Fees and separate agreements"],
  ["suspension", "Suspension and termination"],
  ["disclaimers", "Disclaimers"],
  ["liability", "Limitation of liability"],
  ["law", "Governing law and disputes"],
  ["changes", "Changes to these terms"],
  ["contact", "Contact"],
] as const;

type SectionId = (typeof SECTIONS)[number][0];

export function TermsOfServicePage() {
  useEffect(() => {
    const previous = document.title;
    document.title = "Terms of Service · PRISIM Client Audit Portal";
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
          <Brand />
          <Link to="/login" className="text-sm font-semibold text-accent-700 hover:text-accent-800">
            Sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-5 py-10 sm:px-8 sm:py-14">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent-700">Legal</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink-950 sm:text-4xl">Terms of Service</h1>
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600">
          <div className="flex gap-1.5"><dt className="font-medium">Effective date:</dt><dd>{TERMS_EFFECTIVE_DATE}</dd></div>
          <div className="flex gap-1.5"><dt className="font-medium">Last updated:</dt><dd>{TERMS_LAST_UPDATED}</dd></div>
        </dl>

        <p className="mt-6 max-w-3xl text-base leading-7 text-slate-700">
          These terms govern access to and use of the PRISIM Client Audit Portal at{" "}
          <span className="font-medium text-ink-950">audit.prisim.co.in</span>. Please read them together with our{" "}
          <Link to="/privacy-policy" className="font-medium text-accent-700 underline-offset-2 hover:underline">Privacy Policy</Link>,
          which explains how personal data is handled.
        </p>

        <nav aria-label="Contents" className="mt-8 rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
          <h2 className="text-sm font-semibold text-ink-950">Contents</h2>
          <ol className="mt-3 grid gap-1.5 text-sm text-slate-600 sm:grid-cols-2">
            {SECTIONS.map(([id, title], index) => (
              <li key={id}>
                <a href={`#${id}`} className="hover:text-accent-700 hover:underline">
                  {index + 1}. {title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-10 space-y-10 text-[15px] leading-7 text-slate-700">
          <Section id="acceptance">
            <p>
              The PRISIM Client Audit Portal (the &ldquo;portal&rdquo;) is operated by <strong>PRISIM</strong>
              (&ldquo;PRISIM&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;). By signing in to or using the portal, you
              agree to these terms on your own behalf and, where you use the portal for a client organisation, on
              behalf of that organisation. If you do not agree, do not use the portal.
            </p>
            <CompanyAddress />
          </Section>

          <Section id="service">
            <p>
              PRISIM uses the portal to analyse its clients&apos; advertising performance and to share the results
              with them. With a client&apos;s authorisation, the portal reads advertising account, campaign and
              performance data from Meta and Google, shows dashboards, and lets PRISIM prepare audits and PDF reports
              that it publishes to the client&apos;s workspace.
            </p>
          </Section>

          <Section id="accounts">
            <List
              items={[
                "The portal is a business service with no public sign-up. PRISIM staff create accounts for people authorised by a client organisation and give each account access only to that organisation's workspace.",
                "You must be authorised by your organisation to use the portal and to see its data, and you must give accurate information.",
                "Accounts are personal. Do not share your account or let anyone else use it.",
                "Your organisation is responsible for telling PRISIM when a user should no longer have access.",
              ]}
            />
          </Section>

          <Section id="security">
            <p>
              Keep your password and any sign-in codes confidential, and use a strong password that you do not use
              elsewhere. PRISIM staff accounts must use multi-factor authentication. If you believe your account has
              been used without permission, contact us at <MailLink /> straight away.
            </p>
          </Section>

          <Section id="authorisations">
            <List
              items={[
                "A client that asks PRISIM to connect its advertising accounts confirms that it has the right to do so and to let PRISIM read the data in those accounts.",
                "Advertising accounts are connected by PRISIM staff using the authorisation the client or its representative grants on the Meta or Google sign-in screen. Only accounts made available through that authorisation can be read.",
                "A client can ask PRISIM to disconnect an account at any time, and can also remove PRISIM's access in its Meta or Google settings. Disconnecting stops further synchronisation; data already synchronised is handled as described in the Privacy Policy.",
              ]}
            />
          </Section>

          <Section id="integrations">
            <p>
              The portal only reads advertising data. It does not create, edit, pause or delete campaigns or ads,
              and it does not change budgets or billing. Your use of Meta and Google products
              remains subject to their own terms and policies. The integrations depend on those platforms, which may
              change, limit or withdraw access; PRISIM is not responsible for their availability or for the accuracy
              of the data they return.
            </p>
          </Section>

          <Section id="acceptable-use">
            <p>You must not:</p>
            <List
              items={[
                "access, or try to access, another organisation's workspace or data, or any part of the portal you have not been given access to;",
                "test, probe or bypass the portal's security, authentication or access controls, except with PRISIM's written permission;",
                "copy, scrape or extract data from the portal by automated means, or interfere with its normal operation;",
                "reverse engineer, decompile or copy the portal's software, except where the law permits this despite these terms;",
                "use the portal for any unlawful purpose or in breach of the terms of Meta, Google or other platforms; or",
                "upload or send malicious code, or misrepresent your identity or authority.",
              ]}
            />
          </Section>

          <Section id="client-data">
            <p>
              As between the client and PRISIM, the client keeps its rights in its advertising data. The client allows
              PRISIM to process that data to provide the portal and its audits and reports to the client. PRISIM does
              not sell client data. How personal data is collected, used, shared, retained and deleted is described
              in the <Link to="/privacy-policy" className="font-medium text-accent-700 underline-offset-2 hover:underline">Privacy Policy</Link>.
            </p>
          </Section>

          <Section id="audits">
            <p>
              Audits, scores, findings and reports are PRISIM&apos;s professional assessment of the data available
              to it at the time. They are provided for information and to support the client&apos;s decisions; they
              do not guarantee any advertising result, cost or revenue. The client remains responsible for decisions
              about its advertising accounts and for changes it makes to them.
            </p>
          </Section>

          <Section id="ip">
            <p>
              The portal, its software, design and audit methodology belong to PRISIM or its licensors. Subject to
              these terms, a client may use, copy and share the reports published to its workspace for its own
              business purposes. No other rights are granted.
            </p>
          </Section>

          <Section id="confidentiality">
            <p>
              PRISIM treats each client&apos;s workspace data as confidential and shows it only to that
              client&apos;s users and to authorised PRISIM staff, except where disclosure is described in the Privacy
              Policy or required by law. Users must keep non-public information about the portal confidential.
            </p>
          </Section>

          <Section id="availability">
            <p>
              We aim to keep the portal available and secure, but it may be interrupted for maintenance, updates or
              reasons outside our control, and we do not promise that it will be uninterrupted or error-free. We may
              change, add or remove features. Where a change materially reduces the service a client receives, we
              will tell the client in advance where reasonably possible.
            </p>
          </Section>

          <Section id="fees">
            <p>
              These terms do not set any fees. Any fees, deliverables and service levels for PRISIM&apos;s services
              are set out in the client&apos;s separate written agreement with PRISIM. If that agreement conflicts
              with these terms, the agreement prevails.
            </p>
          </Section>

          <Section id="suspension">
            <List
              items={[
                "PRISIM may suspend or remove a user's access, or deactivate a client organisation, if these terms are breached, to protect the portal or its users, when a client relationship ends, or where the law requires it.",
                "A client can ask PRISIM to remove users, disconnect advertising accounts or delete its data by emailing the contact below. Deletion follows the Privacy Policy.",
                "Sections that by their nature should continue after access ends, including sections 9, 10, 11, 15, 16 and 17, continue to apply.",
              ]}
            />
          </Section>

          <Section id="disclaimers">
            <p>
              To the extent permitted by law, the portal is provided &ldquo;as is&rdquo; and &ldquo;as
              available&rdquo;, without warranties of any kind beyond those expressly given in a separate written
              agreement. We do not warrant that data obtained from advertising platforms is complete or accurate.
            </p>
          </Section>

          <Section id="liability">
            <p>
              To the extent permitted by law, PRISIM is not liable for any indirect, incidental, special or
              consequential loss, or for loss of profits, revenue, business or data, arising from use of the portal.
              Nothing in these terms limits liability that cannot be limited under applicable law. Any other
              limitation of liability is as set out in the client&apos;s separate written agreement with PRISIM.
            </p>
          </Section>

          <Section id="law">
            <p>
              These terms are governed by the laws of India. Subject to any dispute-resolution clause in a separate
              written agreement, the courts at Bengaluru, Karnataka have jurisdiction over disputes arising from them.
              Before starting proceedings, please contact us so that we can try to resolve the matter.
            </p>
          </Section>

          <Section id="changes">
            <p>
              We may update these terms, for example when the portal or the law changes. The effective and
              last-updated dates at the top show when they last changed. Continuing to use the portal after the
              effective date of an update means you accept the updated terms.
            </p>
          </Section>

          <Section id="contact">
            <p>For questions about these terms, contact PRISIM:</p>
            <CompanyAddress />
          </Section>
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl flex-col gap-2 px-5 py-6 text-xs text-slate-500 sm:flex-row sm:justify-between sm:px-8">
          <span>
            © {new Date().getFullYear()} PRISIM. All rights reserved. ·{" "}
            <Link to="/privacy-policy" className="hover:text-accent-700">Privacy Policy</Link>
          </span>
          <a href="#acceptance" className="hover:text-accent-700">Back to top</a>
        </div>
      </footer>
    </div>
  );
}

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  const index = SECTIONS.findIndex(([sectionId]) => sectionId === id);
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6 space-y-3">
      <h2 id={`${id}-title`} className="text-xl font-semibold text-ink-950">
        <a href={`#${id}`} className="hover:text-accent-700">{index + 1}. {SECTIONS[index][1]}</a>
      </h2>
      {children}
    </section>
  );
}

function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-2 pl-5 marker:text-slate-400">
      {items.map((item, index) => <li key={index}>{item}</li>)}
    </ul>
  );
}

function CompanyAddress() {
  return (
    <address className="rounded-xl border border-slate-200 bg-white p-5 not-italic">
      <strong className="text-ink-950">PRISIM</strong><br />
      {PRISIM_ADDRESS_LINES.map((line) => <span key={line}>{line}<br /></span>)}
      Email: <MailLink />
    </address>
  );
}

function MailLink() {
  return (
    <a href={`mailto:${PRIVACY_CONTACT_EMAIL}`} className="font-medium text-accent-700 underline-offset-2 hover:underline">
      {PRIVACY_CONTACT_EMAIL}
    </a>
  );
}
