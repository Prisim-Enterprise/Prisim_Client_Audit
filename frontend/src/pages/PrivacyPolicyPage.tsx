import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Brand } from "../components/Brand";

/**
 * Public privacy policy (no sign-in required): https://audit.prisim.co.in/privacy-policy
 *
 * Retention statements describe the behaviour implemented in the application
 * and database (scheduled clean-up jobs, Vault credential deletion, staff-only
 * deletion of audits and reports, append-only audit log). Keep them in step
 * with supabase/migrations if that behaviour changes.
 */

export const PRIVACY_CONTACT_EMAIL = "info@prisim.co.in";
export const PRIVACY_LAST_UPDATED = "17 November 2026";
export const PRISIM_REGISTERED_ADDRESS =
  "#18, 3rd Floor, Ramachandra Arcade, Opp. Ramaiah College Bus Stop, MSR Road, Mathikere, Bangalore - 560054";

const SECTIONS = [
  ["who-we-are", "Who we are"],
  ["scope", "What this policy covers"],
  ["data-we-collect", "Information we collect"],
  ["advertising-platforms", "Meta and Google advertising data"],
  ["how-we-use", "How we use information"],
  ["sharing", "Who we share information with"],
  ["security", "How we protect information"],
  ["retention", "Retention and deletion"],
  ["your-choices", "Your choices and rights"],
  ["deletion-requests", "How to request deletion"],
  ["browser-storage", "Cookies and browser storage"],
  ["children", "Children"],
  ["changes", "Changes to this policy"],
  ["contact", "Contact us"],
] as const;

export function PrivacyPolicyPage() {
  useEffect(() => {
    const previous = document.title;
    document.title = "Privacy Policy · PRISIM Client Audit Portal";
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
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink-950 sm:text-4xl">Privacy Policy</h1>
        <p className="mt-3 text-sm text-slate-500">Last updated: {PRIVACY_LAST_UPDATED}</p>

        <p className="mt-6 max-w-3xl text-base leading-7 text-slate-700">
          This policy explains how PRISIM collects, uses, shares and retains information in the PRISIM Client
          Audit Portal at <span className="font-medium text-ink-950">audit.prisim.co.in</span>, including
          advertising data that our clients authorise us to read from Meta and Google.
        </p>

        <nav aria-label="Contents" className="mt-8 rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
          <h2 className="text-sm font-semibold text-ink-950">Contents</h2>
          <ol className="mt-3 grid gap-1.5 text-sm text-slate-600 sm:grid-cols-2">
            {SECTIONS.map(([id, title], index) => (
              <li key={id}>
                <a href={`#${id}`} className="hover:text-accent-700">
                  {index + 1}. {title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-10 space-y-10 text-[15px] leading-7 text-slate-700">
          <Section id="who-we-are" title="1. Who we are">
            <p>
              The portal is operated by <strong>PRISIM</strong>, the party responsible for the personal information
              described in this policy.
            </p>
            <address className="mt-3 not-italic">
              PRISIM<br />
              {PRISIM_REGISTERED_ADDRESS}<br />
              Email: <MailLink />
            </address>
          </Section>

          <Section id="scope" title="2. What this policy covers">
            <p>
              The portal is a business tool. PRISIM staff set up client organisations and their user accounts,
              connect the client&apos;s Meta and Google advertising accounts with the client&apos;s authorisation,
              and use the portal to analyse advertising performance and publish audits and reports. Client users
              sign in to view analytics, audit findings and reports for their own organisation. The portal has
              no public sign-up.
            </p>
            <p>
              This policy covers the portal only. Meta, Google and other services you use have their own privacy
              policies.
            </p>
          </Section>

          <Section id="data-we-collect" title="3. Information we collect">
            <List
              items={[
                <><strong>Account information:</strong> name, email address and an optional profile picture for each
                  user account, the organisation and role the account belongs to, and whether its access is active.
                  Passwords are handled by our authentication provider and are not visible to PRISIM. PRISIM staff
                  accounts also use an authenticator app for two-step verification.</>,
                <><strong>Advertising account information:</strong> for ad accounts a client authorises, the account
                  ID, name, currency, time zone and status, and the Meta business ID associated with the connection.</>,
                <><strong>Campaign and performance data:</strong> campaign names, objectives, statuses, budgets and
                  bidding settings, and daily performance figures such as impressions, reach, clicks, spend,
                  conversions and conversion value.</>,
                <><strong>Connection credentials:</strong> the access credentials Meta or Google issue when a client
                  authorises a connection, and the permissions that were granted.</>,
                <><strong>Audits and reports:</strong> audit scores, findings and recommendations PRISIM prepares from
                  the data above, and the PDF reports generated from them.</>,
                <><strong>Activity and security records:</strong> records of changes made in the portal (for example
                  account, connection, audit and report changes), including who made the change and when, and
                  records of data synchronisation runs.</>,
                <><strong>Technical information:</strong> our hosting and infrastructure providers process technical
                  data such as IP addresses and request details to deliver and secure the service.</>,
              ]}
            />
          </Section>

          <Section id="advertising-platforms" title="4. Meta and Google advertising data">
            <p>
              Advertising accounts are connected only by PRISIM staff, with the authorisation of the client who
              controls them. Access is read-only in the portal and limited to the accounts the client authorises.
            </p>
            <h3 className="pt-1 text-base font-semibold text-ink-950">Meta</h3>
            <p>
              The client grants access through Meta&apos;s business login and chooses which business assets to share
              with PRISIM. Our Meta login configuration requests the following permissions:
            </p>
            <List
              items={[
                <><code>ads_read</code>: to read the shared ad accounts and their campaign and performance data.</>,
                <><code>business_management</code>: to identify the client business and the business assets it has
                  shared with PRISIM.</>,
                <><code>pages_show_list</code> and <code>pages_read_engagement</code>: these allow an app to list
                  the Facebook Pages a client shares and read basic Page information and engagement. They are part of
                  our Meta configuration, but the portal does not currently use them to retrieve or store any Page
                  information.</>,
              ]}
            />
            <p>
              The portal currently retrieves and stores ad account, campaign and performance data only from the ad
              accounts explicitly shared with PRISIM, and the client business ID needed to identify the connection.
              It does not currently retrieve or store Facebook Page content, posts, comments or Page engagement data,
              and it does not access personal profiles of the client&apos;s customers or audiences. If we begin using
              Page data, it will be used only for the client&apos;s analytics, audits and reports, and we will update
              this policy.
            </p>
            <h3 className="pt-1 text-base font-semibold text-ink-950">Google</h3>
            <p>
              Where Google Ads connections are offered, the client signs in with Google and grants access to the
              Google Ads accounts they manage, and the portal reads account, campaign and performance data from those
              accounts. PRISIM&apos;s use and transfer of information received from Google APIs will adhere to the{" "}
              <a
                href="https://developers.google.com/terms/api-services-user-data-policy"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-accent-700 hover:text-accent-800"
              >
                Google API Services User Data Policy
              </a>
              , including the Limited Use requirements.
            </p>
            <h3 className="pt-1 text-base font-semibold text-ink-950">For both platforms</h3>
            <List
              items={[
                "We use this access only to provide the client's own analytics, audits and reports.",
                "The portal does not create, edit, pause or delete campaigns, ads, budgets or Pages.",
                "We do not sell this data, use it to build advertising profiles, or use it for our own advertising.",
                "We do not share one client's advertising data with another client.",
              ]}
            />
          </Section>

          <Section id="how-we-use" title="5. How we use information">
            <List
              items={[
                "To create and manage client organisations and user accounts and to control who can access each organisation's data.",
                "To connect authorised advertising accounts and synchronise their data.",
                "To produce analytics, audits, findings, recommendations and reports for the client.",
                "To secure the portal, prevent misuse, investigate problems and keep a record of changes.",
                "To communicate with clients about their accounts and our services.",
                "To meet legal obligations and to establish, exercise or defend legal claims.",
              ]}
            />
          </Section>

          <Section id="sharing" title="6. Who we share information with">
            <p>We share information only as needed to run the portal or where the law requires it:</p>
            <List
              items={[
                <><strong>Service providers</strong> that host and operate the portal for us: Supabase (database,
                  authentication, file storage and server functions; our Supabase project is hosted in the Mumbai,
                  India region) and Vercel (website hosting and delivery through its global network). They process
                  information on our behalf.</>,
                <><strong>Meta and Google</strong>, when the portal calls their APIs to read the data a client has
                  authorised.</>,
                <><strong>Authorised users</strong> of the client organisation the data belongs to, and PRISIM
                  staff who manage that client.</>,
                <><strong>Authorities or other parties</strong> where required by law, or to protect the rights,
                  safety and security of PRISIM, our clients or others.</>,
              ]}
            />
            <p>We do not sell personal information.</p>
          </Section>

          <Section id="security" title="7. How we protect information">
            <List
              items={[
                "Database access rules separate each client organisation's data, so client users can only read data for organisations they are active members of.",
                "Access is role-based: client users have an owner or viewer role for their own organisation, while creating accounts, assigning roles, connecting advertising accounts and other administrative actions are limited to PRISIM staff who sign in with two-step verification.",
                "Advertising platform credentials are kept in Supabase Vault, which stores secrets in encrypted form. They are used only by our server functions and are never sent to web browsers.",
                "The portal is served over HTTPS. Report files are stored in private storage and downloaded through links that expire shortly after they are created.",
              ]}
            />
            <p>
              No method of transmission or storage is completely secure, and we cannot guarantee absolute security,
              but we take reasonable measures to protect information against unauthorised access, loss and misuse.
            </p>
          </Section>

          <Section id="retention" title="8. Retention and deletion">
            <p>
              We keep information while we provide the service to a client and as needed for the purposes in this
              policy. The portal currently handles retention as follows:
            </p>
            <List
              items={[
                <><strong>Advertising, campaign and performance data</strong> is kept while the client&apos;s
                  organisation is maintained in the portal. It does not expire automatically. The portal stores
                  processed figures; where raw data returned by an advertising platform is stored with them, a
                  scheduled daily job clears it after approximately 14 days.</>,
                <><strong>Disconnecting an advertising account:</strong> when PRISIM disconnects a connection, the
                  stored access credentials are deleted from Supabase Vault and the connection is marked as revoked.
                  Disconnecting does not automatically delete historical campaign and performance data, audits,
                  reports or activity records. We also ask the platform to revoke access where it supports this; you
                  can always remove access yourself (see section 9).</>,
                <><strong>Audits and reports</strong> are kept until PRISIM staff delete them. Deleting a report
                  removes its PDF file and its record; deleting an audit removes its findings.</>,
                <><strong>Synchronisation history</strong> is deleted by a scheduled job after approximately 90
                  days, and expired short-lived authorisation records after approximately 30 days.</>,
                <><strong>Activity and security records</strong> are written to an append-only log that has no
                  automatic expiry and that the portal does not edit or delete, including after an account or
                  organisation is removed. This log excludes passwords, access credentials and raw
                  advertising-platform data.</>,
                <><strong>Deactivated clients and users:</strong> when a client organisation is deactivated or
                  suspended, its users can no longer access its data, but the data is kept. Removing a user&apos;s
                  access to an organisation does not by itself delete their user account.</>,
                <><strong>Backups and provider logs:</strong> copies of information may remain for a period in
                  backups and logs maintained by our infrastructure providers, under their own retention
                  arrangements.</>,
              ]}
            />
            <p>
              Other deletion, including deleting a client organisation, its advertising data or a user account, is
              carried out by PRISIM on request (see section 10), subject to the activity log and backup points
              above and to any information we must keep by law.
            </p>
          </Section>

          <Section id="your-choices" title="9. Your choices and rights">
            <List
              items={[
                <>Depending on the law that applies to you, you may be able to ask us for access to, correction of
                  or deletion of your personal information, to withdraw a consent you gave, or to raise a grievance.
                  Email <MailLink /> and we will respond within a reasonable time and as required by applicable law.</>,
                "Signed-in users can update their own name and profile picture in the portal.",
                <>You can remove PRISIM&apos;s access to your advertising data at any time: for Meta, by removing
                  PRISIM under your business&apos;s connected apps or business integrations in Meta&apos;s settings; for
                  Google, in your Google Account&apos;s third-party connections. Please also tell us so we can
                  disconnect the connection in the portal.</>,
                "If your organisation is a PRISIM client, some requests may need to come from, or be agreed with, your organisation's account owner.",
              ]}
            />
          </Section>

          <Section id="deletion-requests" title="10. How to request deletion">
            <p>
              To ask us to delete data, including data received from Meta or Google, email <MailLink /> from the
              email address linked to your account, or from your organisation&apos;s account owner, with the subject
              &ldquo;Data deletion request&rdquo;. Tell us which organisation, user account or advertising account
              the request concerns. We will confirm receipt, may ask you to verify your identity or authority, and
              will tell you what was deleted and what we keep (for example the activity log and backup copies
              described in section 8, or information we must keep by law). Deletion is carried out by PRISIM staff
              and is not instant.
            </p>
          </Section>

          <Section id="browser-storage" title="11. Cookies and browser storage">
            <p>
              The portal does not use advertising or third-party analytics cookies. It stores your sign-in session
              in your browser&apos;s local storage so you stay signed in, and briefly stores navigation details while
              an advertising account connection is completed. Signing out removes your session from the browser.
            </p>
          </Section>

          <Section id="children" title="12. Children">
            <p>The portal is a business service and is not intended for children. We do not knowingly collect information from children.</p>
          </Section>

          <Section id="changes" title="13. Changes to this policy">
            <p>
              We may update this policy, for example when the portal changes. We will post the updated policy on this
              page and change the &ldquo;Last updated&rdquo; date above.
            </p>
          </Section>

          <Section id="contact" title="14. Contact us">
            <p>For questions, requests or grievances about this policy or your information, contact:</p>
            <address className="mt-3 not-italic">
              PRISIM<br />
              {PRISIM_REGISTERED_ADDRESS}<br />
              Email: <MailLink />
            </address>
          </Section>
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-4xl px-5 py-6 text-xs text-slate-500 sm:px-8">
          © {new Date().getFullYear()} PRISIM. All rights reserved.
        </div>
      </footer>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6 space-y-3">
      <h2 id={`${id}-title`} className="text-xl font-semibold text-ink-950">{title}</h2>
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

function MailLink() {
  return (
    <a href={`mailto:${PRIVACY_CONTACT_EMAIL}`} className="font-medium text-accent-700 hover:text-accent-800">
      {PRIVACY_CONTACT_EMAIL}
    </a>
  );
}
