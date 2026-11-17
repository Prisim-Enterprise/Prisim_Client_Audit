import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Brand } from "../components/Brand";

/**
 * Public privacy policy (no sign-in required): https://audit.prisim.co.in/privacy-policy
 *
 * Every statement must match the implementation or a confirmed PRISIM
 * commitment. The evidence for each statement is tracked in
 * docs/privacy-policy-evidence.md; update both together.
 */

export const PRIVACY_CONTACT_EMAIL = "info@prisim.co.in";
export const PRIVACY_EFFECTIVE_DATE = "17 November 2026";
export const PRIVACY_LAST_UPDATED = "17 November 2026";
export const PRISIM_ADDRESS_LINES = [
  "#18, 3rd Floor, Ramachandra Arcade,",
  "Opp. Ramaiah College Bus Stop,",
  "MSR Road, Mathikere,",
  "Bangalore - 560054.",
] as const;

const SECTIONS = [
  ["introduction", "Introduction and who we are"],
  ["scope", "Scope and applicability"],
  ["definitions", "Definitions"],
  ["roles", "Our role: Data Fiduciary or Data Processor"],
  ["categories", "Personal data we collect"],
  ["sources", "Sources of personal data"],
  ["purposes", "Purposes of processing"],
  ["legal-bases", "Grounds for processing"],
  ["notice-consent", "Notice and consent"],
  ["consent-records", "How consent and authorisations are recorded"],
  ["consent-withdrawal", "Withdrawing consent"],
  ["meta", "Meta advertising integration"],
  ["google", "Google advertising integration"],
  ["supabase-vercel", "Supabase and Vercel"],
  ["other-providers", "Other service providers"],
  ["transfers", "Processing outside India"],
  ["security", "Storage and security safeguards"],
  ["staff-access", "PRISIM staff and administrator access"],
  ["retention", "Retention schedule and criteria"],
  ["deletion", "Deletion and erasure"],
  ["backups", "Backups and provider logs"],
  ["breaches", "Personal data breaches"],
  ["rights", "Your rights as a Data Principal"],
  ["requests", "How to make a request"],
  ["withdrawal-procedure", "Consent withdrawal procedure"],
  ["grievances", "Grievance redressal"],
  ["nomination", "Nomination"],
  ["verification", "Identity verification"],
  ["children", "Children"],
  ["sharing", "Sharing and disclosures"],
  ["browser-storage", "Cookies, local storage and sessions"],
  ["suspension", "Account suspension and termination"],
  ["offboarding", "Client offboarding and account deletion"],
  ["legal-retention", "Legal obligations and retention exceptions"],
  ["changes", "Changes to this policy"],
  ["contact", "Privacy and grievance contact"],
] as const;

type SectionId = (typeof SECTIONS)[number][0];

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
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600">
          <div className="flex gap-1.5"><dt className="font-medium">Effective date:</dt><dd>{PRIVACY_EFFECTIVE_DATE}</dd></div>
          <div className="flex gap-1.5"><dt className="font-medium">Last updated:</dt><dd>{PRIVACY_LAST_UPDATED}</dd></div>
        </dl>

        <p className="mt-6 max-w-3xl text-base leading-7 text-slate-700">
          This policy explains how PRISIM collects, uses, shares, stores and deletes personal data in the PRISIM
          Client Audit Portal at <span className="font-medium text-ink-950">audit.prisim.co.in</span>, including
          advertising data that our clients authorise us to read from Meta and Google, and how you can exercise
          your rights. It is written with reference to India&apos;s Digital Personal Data Protection Act, 2023
          (the &ldquo;DPDP Act&rdquo;) and the Digital Personal Data Protection Rules, 2025.
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
          <Section id="introduction">
            <p>
              The PRISIM Client Audit Portal (the &ldquo;portal&rdquo;) is operated by <strong>PRISIM</strong>.
              PRISIM uses the portal to analyse its clients&apos; advertising performance and to publish audits and
              reports to them.
            </p>
            <CompanyAddress />
          </Section>

          <Section id="scope">
            <p>This policy applies to personal data processed through the portal, including data about:</p>
            <List
              items={[
                "users of client organisations who are given access to the portal;",
                "contact persons of client organisations whose details PRISIM records;",
                "PRISIM staff who administer the portal; and",
                "any individual whose personal data is contained in information that clients authorise PRISIM to read from advertising platforms.",
              ]}
            />
            <p>
              The portal is a business service with no public sign-up: accounts are created by PRISIM staff for
              client organisations. This policy does not cover PRISIM&apos;s other websites or services, or the
              services of Meta, Google or other companies, which have their own privacy policies.
            </p>
          </Section>

          <Section id="definitions">
            <List
              items={[
                <><strong>Personal data</strong>: any data about an individual who is identifiable by or in relation
                  to that data.</>,
                <><strong>Data Principal</strong>: the individual to whom personal data relates (&ldquo;you&rdquo;).</>,
                <><strong>Data Fiduciary</strong>: a person who, alone or with others, decides the purpose and means
                  of processing personal data.</>,
                <><strong>Data Processor</strong>: a person who processes personal data on behalf of a Data
                  Fiduciary.</>,
                <><strong>Processing</strong>: any operation on personal data, such as collection, storage, use,
                  sharing or erasure.</>,
                <><strong>Client</strong>: an organisation for which PRISIM provides advertising audits and reports
                  through the portal, and <strong>client user</strong>: a person given access to the portal for a
                  client.</>,
                <><strong>Board</strong>: the Data Protection Board of India established under the DPDP Act.</>,
              ]}
            />
          </Section>

          <Section id="roles">
            <p>Our role depends on the processing activity:</p>
            <List
              items={[
                <><strong>PRISIM as Data Fiduciary</strong>: for the accounts of client users and PRISIM staff,
                  client contact details, portal security and activity records, and communications with you. We
                  decide why and how this data is processed.</>,
                <><strong>PRISIM on behalf of clients</strong>: advertising account, campaign and performance data
                  is processed to provide services to the client that authorised access to it. Most of this data is
                  aggregated business information rather than personal data. Where it contains personal data, PRISIM
                  may act as a Data Processor for the client, depending on the arrangement with that client, and the
                  client may be the Data Fiduciary.</>,
              ]}
            />
          </Section>

          <Section id="categories">
            <List
              items={[
                <><strong>Account data</strong>: name (optional), email address, profile picture if provided,
                  organisation membership, role (owner or viewer for client users), access status, and sign-in
                  timestamps. Passwords are handled by our authentication provider in a form PRISIM cannot read.
                  PRISIM staff accounts also use an authenticator app for two-step verification.</>,
                <><strong>Client contact data</strong>: the client&apos;s business name and, where provided, industry,
                  website, primary contact name and contact email.</>,
                <><strong>Advertising account data</strong>: for ad accounts a client authorises, the account ID, name,
                  currency, time zone and status, and for Meta the client business ID associated with the
                  connection.</>,
                <><strong>Campaign and performance data</strong>: campaign names, objectives, statuses, budgets and
                  bidding settings, and daily figures such as impressions, reach, clicks, spend, conversions and
                  conversion value.</>,
                <><strong>Connection credentials</strong>: access credentials issued by Meta or Google when a client
                  authorises a connection, and the permissions granted.</>,
                <><strong>Audits and reports</strong>: audit scores, findings and recommendations, and PDF reports.</>,
                <><strong>Activity and security records</strong>: records of changes made in the portal, including
                  who made the change and when, and records of data synchronisation runs.</>,
                <><strong>Technical data</strong>: IP addresses, browser and request details processed by our hosting
                  providers to deliver and secure the service.</>,
                <><strong>Correspondence</strong>: messages you send us, including privacy requests.</>,
              ]}
            />
          </Section>

          <Section id="sources">
            <List
              items={[
                "From the client organisation and PRISIM staff, who provide client details and create user accounts.",
                "From you, for example when you set your password, sign in or write to us.",
                "From Meta and Google, when a client authorises PRISIM to read its advertising data.",
                "Automatically, from your use of the portal (activity records and technical data).",
              ]}
            />
          </Section>

          <Section id="purposes">
            <List
              items={[
                "To create and manage client organisations and user accounts, and to control who can access each organisation's data.",
                "To connect authorised advertising accounts and synchronise their data.",
                "To produce analytics, audits, findings, recommendations and reports for the client.",
                "To secure the portal, prevent misuse, investigate problems and keep a record of changes.",
                "To communicate with clients and users about their accounts and our services.",
                "To respond to privacy requests and grievances.",
                "To comply with legal obligations and to establish, exercise or defend legal claims.",
              ]}
            />
            <p>We do not use personal data from the portal for advertising, profiling or sale.</p>
          </Section>

          <Section id="legal-bases">
            <p>We process personal data on the grounds permitted by the DPDP Act, namely:</p>
            <List
              items={[
                <><strong>Consent</strong>, where we ask for it, for example a client&apos;s authorisation to connect
                  its advertising accounts.</>,
                <><strong>Certain legitimate uses</strong> recognised by the DPDP Act, including where personal data is
                  voluntarily provided for a specified purpose (for example, a client providing the details of the
                  users who should have access) and the person has not indicated that they do not consent, and where
                  processing is needed to comply with law.</>,
              ]}
            />
          </Section>

          <Section id="notice-consent">
            <p>
              This policy is our notice describing the personal data we process and why. It is publicly available
              at this address and linked from the portal&apos;s sign-in pages and the portal itself.
            </p>
            <p>
              Advertising data is accessed only after the client authorises it on Meta&apos;s or Google&apos;s own
              consent screens, which show the permissions requested. User accounts are created by PRISIM staff at
              the client&apos;s request; the portal does not currently display a separate consent screen when an
              account is created or first used.
            </p>
          </Section>

          <Section id="consent-records">
            <List
              items={[
                "When an advertising account is connected or disconnected, the portal records which PRISIM staff member did it, for which client and when, in its activity log, together with the permissions the platform reported as granted.",
                "Meta and Google keep their own records of the authorisations given on their platforms.",
                "Creation of user accounts and changes to access are also recorded in the activity log.",
              ]}
            />
            <p>The portal does not currently provide an in-app record of individual consents.</p>
          </Section>

          <Section id="consent-withdrawal">
            <p>
              Where processing is based on consent, you may withdraw it at any time, as easily as it was given.
              Withdrawal does not affect processing carried out before it. After withdrawal we stop the processing
              that relied on it within a reasonable time, unless another ground under law applies. Withdrawal may
              mean that we can no longer provide some or all of the service. See section 25 for how to withdraw.
            </p>
          </Section>

          <Section id="meta">
            <p>
              Meta advertising accounts are connected only by PRISIM staff, with the authorisation of the client who
              controls them. The client grants access through Meta&apos;s business login and chooses which business
              assets to share with PRISIM. Our Meta login configuration requests these permissions:
            </p>
            <List
              items={[
                <><code>ads_read</code>: to read the shared ad accounts and their campaign and performance data.</>,
                <><code>business_management</code>: to identify the client business and the business assets it has
                  shared with PRISIM.</>,
                <><code>pages_show_list</code> and <code>pages_read_engagement</code>: these allow an app to list the
                  Facebook Pages a client shares and read basic Page information and engagement. They are part of our
                  Meta configuration, but the portal does not currently use them to retrieve or store any Page
                  information.</>,
              ]}
            />
            <p>
              The portal currently retrieves and stores ad account, campaign and performance data only from ad
              accounts explicitly shared with PRISIM, and the client business ID needed to identify the connection.
              It does not retrieve or store Facebook Page content, posts, comments or Page engagement data, and does
              not access personal profiles of the client&apos;s customers or audiences. The portal does not create,
              edit, pause or delete campaigns, ads, budgets or Pages. If we begin using Page data, it will be used
              only for the client&apos;s analytics, audits and reports, and we will update this policy first.
            </p>
          </Section>

          <Section id="google">
            <p>
              Where Google Ads connections are offered, the client signs in with Google and grants access to the
              Google Ads accounts they manage. The portal reads account, campaign and performance data from those
              accounts for the client&apos;s analytics, audits and reports, and does not change campaigns or
              settings.
            </p>
            <p>
              PRISIM&apos;s use and transfer of information received from Google APIs will adhere to the{" "}
              <ExternalLink href="https://developers.google.com/terms/api-services-user-data-policy">
                Google API Services User Data Policy
              </ExternalLink>
              , including the Limited Use requirements.
            </p>
          </Section>

          <Section id="supabase-vercel">
            <List
              items={[
                <><strong>Supabase</strong> provides the portal&apos;s database, user authentication (including
                  sign-in and password emails), file storage for reports, and server functions. Our Supabase project
                  is hosted in the Mumbai, India region.</>,
                <><strong>Vercel</strong> hosts the portal&apos;s website and delivers it through its global network,
                  which processes technical data such as IP addresses and request details.</>,
              ]}
            />
            <p>These providers process personal data on our behalf to run the portal.</p>
          </Section>

          <Section id="other-providers">
            <p>
              Meta and Google receive requests from the portal when it reads the data a client has authorised; they
              are independent platforms with their own privacy policies. The portal does not use third-party
              analytics or advertising services. If we add a provider that processes personal data, we will update
              this policy.
            </p>
          </Section>

          <Section id="transfers">
            <p>
              Portal data is stored in our Supabase project in India. Some processing takes place outside India, for
              example when Vercel&apos;s global network delivers the website and when the portal exchanges data with
              Meta and Google, whose services operate internationally. Any transfer of personal data outside India is
              subject to the DPDP Act, including any restrictions notified by the Government of India.
            </p>
          </Section>

          <Section id="security">
            <List
              items={[
                "Database access rules separate each client organisation's data, so client users can only read data for organisations they are active members of.",
                "Access is role-based, and administrative actions are limited to PRISIM staff (see section 18).",
                "Advertising platform credentials are kept in an encrypted secrets store, are used only by our server functions and are never sent to web browsers.",
                "The portal is served over HTTPS. Report files are kept in private storage and downloaded through links that expire shortly after they are created.",
                "Changes to important records are written to an activity log that cannot be edited or deleted through the portal.",
              ]}
            />
            <p>
              No method of transmission or storage is completely secure, and we cannot guarantee absolute security,
              but we take reasonable measures to protect personal data against unauthorised access, loss and misuse.
            </p>
          </Section>

          <Section id="staff-access">
            <p>
              Only PRISIM staff registered as portal administrators can create client organisations and user
              accounts, assign roles, connect or disconnect advertising accounts, and run audits and reports. They
              must sign in with two-step verification for these actions, and the portal records who performed each
              action. Client users have an owner or viewer role for their own organisation and cannot manage users or
              connections.
            </p>
          </Section>

          <Section id="retention">
            <p>
              We keep personal data only as long as it is needed for the purposes in this policy or required by law.
              The portal currently applies the following retention:
            </p>
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full min-w-[560px] text-left text-sm">
                <caption className="sr-only">Retention of data in the portal</caption>
                <thead className="bg-slate-50 text-ink-950">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-semibold">Data</th>
                    <th scope="col" className="px-4 py-3 font-semibold">How long it is kept</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 align-top">
                  {RETENTION.map(([data, period]) => (
                    <tr key={data}>
                      <th scope="row" className="px-4 py-3 font-medium text-ink-950">{data}</th>
                      <td className="px-4 py-3">{period}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              Where no fixed period applies, we keep data while the client relationship continues because clients
              use historical performance data, audits and reports for comparison over time. These criteria are
              subject to legal review and may change; we will update this policy if they do.
            </p>
          </Section>

          <Section id="deletion">
            <List
              items={[
                "PRISIM staff can delete individual audits (with their findings) and reports (with their PDF files) in the portal.",
                "Disconnecting an advertising account deletes its stored access credentials. It does not delete data already synchronised.",
                "Deletion of a client organisation's data, a user account or other data is carried out by PRISIM on request (see sections 24 and 33). It is not instant and is subject to the exceptions in sections 21 and 34.",
              ]}
            />
            <p>
              The portal does not currently offer self-service deletion, and closing or removing an account does not
              by itself delete all of the related information.
            </p>
          </Section>

          <Section id="backups">
            <p>
              Copies of personal data may remain for a period in backups and logs maintained by our infrastructure
              providers, under their own retention arrangements, after the data is deleted from the portal. We
              cannot currently state a fixed period for these copies.
            </p>
          </Section>

          <Section id="breaches">
            <p>
              If we become aware of a personal data breach affecting data we are responsible for, we will act to
              contain it, assess its impact and take steps to prevent recurrence. Where required by the DPDP Act and
              the DPDP Rules, we will inform affected Data Principals and the Data Protection Board of India within
              the time and in the manner the law requires. Where we process data on behalf of a client, we will
              inform that client so that it can meet its own obligations.
            </p>
          </Section>

          <Section id="rights">
            <p>Subject to the DPDP Act and its exceptions, you have the right to:</p>
            <List
              items={[
                <><strong>Access information</strong>: a summary of the personal data we process about you and the
                  processing activities, and the identities of other Data Fiduciaries and Data Processors with whom
                  it has been shared, with a description of the data shared.</>,
                <><strong>Correction, completion and updating</strong> of inaccurate, incomplete or outdated personal
                  data.</>,
                <><strong>Erasure</strong> of personal data that is no longer needed for the purpose for which it was
                  processed, unless retention is necessary for that purpose or for compliance with law.</>,
                <><strong>Withdraw consent</strong> where processing is based on consent.</>,
                <><strong>Grievance redressal</strong> from us, and then, if unresolved, a complaint to the Data
                  Protection Board of India.</>,
                <><strong>Nominate</strong> another individual to exercise your rights in the event of your death or
                  incapacity.</>,
              ]}
            />
            <p>
              These rights apply to processing for which PRISIM is the Data Fiduciary. Where we process data on
              behalf of a client, we may refer your request to that client or assist it in responding. The law also
              sets out duties for Data Principals, such as providing authentic information and not making false or
              frivolous requests or complaints. Some provisions of the DPDP Act and the DPDP Rules, 2025 are being
              brought into force in phases; statutory rights and timelines apply as and when the relevant provisions
              are in force.
            </p>
          </Section>

          <Section id="requests">
            <p>
              The portal does not yet have a self-service privacy or data-rights centre. To make a request about
              access, correction, completion, updating or erasure, email <MailLink /> with the subject &ldquo;Privacy
              request&rdquo; and include:
            </p>
            <List
              items={[
                "your name and the email address registered in the portal (your identifier);",
                "the client organisation your account belongs to, if any;",
                "what you are asking for; and",
                "if you are acting for someone else, proof of your authority.",
              ]}
            />
            <p>
              We reply by email to the address the request came from. We may ask for more information to verify your
              identity (section 28). Our reply will tell you the outcome of your request and, where we cannot act on
              all or part of it, the reason.
            </p>
          </Section>

          <Section id="withdrawal-procedure">
            <List
              items={[
                <>Email <MailLink /> with the subject &ldquo;Consent withdrawal&rdquo;, stating what the withdrawal
                  covers.</>,
                <>To withdraw a client&apos;s authorisation for advertising data, the client can also remove PRISIM
                  under its business&apos;s connected apps or business integrations in Meta&apos;s settings, or in its
                  Google Account&apos;s third-party connections. Please also tell us so we can disconnect the connection
                  in the portal and delete the stored credentials.</>,
              ]}
            />
          </Section>

          <Section id="grievances">
            <p>
              If you have a grievance about how we have handled your personal data or a request, email{" "}
              <MailLink /> with the subject &ldquo;Privacy grievance&rdquo;. We will respond within a reasonable period
              and within the time required by law; the DPDP Rules, 2025 set a maximum of ninety days for responding
              to grievances once the relevant rule is in force. Under the DPDP Act you must first use our grievance
              process before you may complain to the Data Protection Board of India.
            </p>
          </Section>

          <Section id="nomination">
            <p>
              Under the DPDP Act you may nominate one or more individuals to exercise your rights in the event of your
              death or incapacity. To register or change a nomination, email <MailLink /> with the subject
              &ldquo;Nomination&rdquo;, giving the nominee&apos;s name and contact details. We will verify your identity
              before recording it.
            </p>
          </Section>

          <Section id="verification">
            <p>
              To protect your data, we act on a request only when we are reasonably satisfied that it comes from you
              or a person authorised by you. We will normally ask you to write from the email address registered in
              the portal and may ask for further information. We will not ask for your password or authenticator
              codes.
            </p>
          </Section>

          <Section id="children">
            <p>
              The portal is a business service and is not intended for children (under the DPDP Act, individuals
              under 18). We do not knowingly process children&apos;s personal data. If we learn that we have, we will
              take steps to delete it.
            </p>
          </Section>

          <Section id="sharing">
            <p>We do not sell personal data. We disclose it only as follows:</p>
            <List
              items={[
                <><strong>Service providers</strong> that process data on our behalf (sections 14 and 15).</>,
                <><strong>Meta and Google</strong>, when the portal calls their services to read data a client has
                  authorised.</>,
                <><strong>The client organisation and its authorised users</strong>, who can see their own
                  organisation&apos;s data, and PRISIM staff who manage that client. We do not share one client&apos;s
                  data with another client.</>,
                <><strong>Authorities and others where required by law</strong>, or where needed to protect the rights,
                  safety and security of PRISIM, our clients or others.</>,
              ]}
            />
          </Section>

          <Section id="browser-storage">
            <p>
              The portal does not use advertising or third-party analytics cookies. It stores your sign-in session in
              your browser&apos;s local storage so you stay signed in, and briefly stores navigation details in session
              storage while an advertising account connection is completed. Signing out removes your session from the
              browser.
            </p>
          </Section>

          <Section id="suspension">
            <List
              items={[
                "PRISIM may deactivate or suspend a client organisation. Its users then cannot access its data, but the data is kept.",
                "PRISIM may remove a user's access to an organisation. This does not by itself delete the user's account.",
                "Access may also be restricted to protect the portal or comply with law.",
              ]}
            />
          </Section>

          <Section id="offboarding">
            <p>
              When a client relationship ends, the client&apos;s authorised representative or an affected user can ask
              PRISIM to delete the client organisation&apos;s data or a user account by emailing <MailLink />. PRISIM
              then disconnects any advertising connections (deleting their stored credentials) and deletes the
              requested data from the portal&apos;s active systems, subject to sections 21 and 34, and confirms what
              was deleted and what was kept. Deletion is not automatic when a relationship ends.
            </p>
          </Section>

          <Section id="legal-retention">
            <p>
              We may keep personal data where retention is required or permitted by law, or needed to establish,
              exercise or defend legal claims. The portal&apos;s activity log is kept to account for changes and
              access, and is not deleted when an account or organisation is removed. When the law requires a minimum
              retention period for certain records, we keep them for that period.
            </p>
          </Section>

          <Section id="changes">
            <p>
              We may update this policy, for example when the portal or the law changes. The effective and
              last-updated dates at the top show when it last changed. The updated policy applies from its effective
              date.
            </p>
          </Section>

          <Section id="contact">
            <p>
              For questions, requests, consent withdrawal or grievances about your personal data, contact PRISIM:
            </p>
            <CompanyAddress />
          </Section>
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl flex-col gap-2 px-5 py-6 text-xs text-slate-500 sm:flex-row sm:justify-between sm:px-8">
          <span>© {new Date().getFullYear()} PRISIM. All rights reserved.</span>
          <a href="#introduction" className="hover:text-accent-700">Back to top</a>
        </div>
      </footer>
    </div>
  );
}

const RETENTION: Array<[string, string]> = [
  ["Advertising account, campaign and performance data", "While the client organisation is maintained in the portal; no automatic expiry. Where raw data returned by an advertising platform is stored with processed figures, a scheduled daily job clears it after approximately 14 days."],
  ["Synchronisation history", "Deleted by a scheduled job after approximately 90 days."],
  ["Expired authorisation records for administrative actions", "Deleted by a scheduled job approximately 30 days after they expire."],
  ["Advertising connection credentials", "Until the connection is disconnected, when they are deleted. The connection is then kept, marked as revoked."],
  ["Audits and reports", "Until PRISIM staff delete them; no automatic expiry. Disconnecting an advertising account does not delete them."],
  ["Activity (audit) log", "No automatic expiry. The portal does not edit or delete it, including after an account or organisation is removed. It excludes passwords, credentials and raw advertising-platform data."],
  ["User accounts and client contact details", "While the account or client relationship continues, and until deleted on request (section 33). Removing access does not delete an account."],
  ["Privacy requests and correspondence", "As long as needed to handle the request and to show how it was handled."],
  ["Backups and provider logs", "Under our infrastructure providers' retention arrangements (section 21)."],
];

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

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="font-medium text-accent-700 underline-offset-2 hover:underline">
      {children}
    </a>
  );
}
