import { ArrowUpRight, BarChart3, CircleHelp, FileText, Link2, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { Card } from "../../components/ui/Card";
import { useAuth } from "../../context/AuthProvider";

export function ClientDashboard() {
  const { currentTenant, memberships, profile, user } = useAuth();
  const { tenantSlug = "" } = useParams();
  const membership = memberships.find((item) => item.slug === tenantSlug) ?? currentTenant;
  const name = profile?.full_name?.trim().split(/\s+/)[0] || user?.email?.split("@")[0] || "there";

  return (
    <div className="space-y-8">
      <section>
        <p className="text-sm font-medium text-accent-700">{membership?.business_name ?? "Client workspace"}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink-950">Welcome, {name}</h1>
        <p className="mt-2 text-sm text-slate-500">Your advertising performance and audit workspace.</p>
      </section>

      <Card className="overflow-hidden">
        <div className="border-b border-slate-100 px-6 py-5 sm:px-7">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Workspace setup</p>
          <h2 className="mt-2 text-lg font-semibold text-ink-950">Your analytics will appear here</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">
            Once your advertising accounts are connected and the first data sync is complete, this workspace will show your campaign performance, audit findings, and reports.
          </p>
        </div>
        <div className="grid gap-0 sm:grid-cols-3">
          <SetupLink icon={<Link2 />} title="Ad accounts" description="View advertising account connections." href={`/app/${tenantSlug}/accounts`} />
          <SetupLink icon={<BarChart3 />} title="Campaign analytics" description="Explore performance as data becomes available." href={`/app/${tenantSlug}/campaigns`} />
          <SetupLink icon={<ShieldCheck />} title="Audit findings" description="See reviewed opportunities and recommendations." href={`/app/${tenantSlug}/audits`} />
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_0.8fr]">
        <Card className="p-6 sm:p-7">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-600">
              <FileText aria-hidden="true" className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-semibold text-ink-950">Audit reports</h2>
              <p className="mt-0.5 text-xs text-slate-500">Published reports for your workspace</p>
            </div>
          </div>
          <p className="mt-5 text-sm leading-6 text-slate-500">Reports will be listed here once your first audit is complete.</p>
          <Link to={`/app/${tenantSlug}/reports`} className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-accent-700 hover:text-accent-800">
            Go to reports <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        </Card>
        <Card className="bg-ink-950 p-6 text-white sm:p-7">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 text-accent-100">
            <CircleHelp aria-hidden="true" className="h-5 w-5" />
          </div>
          <h2 className="mt-5 font-semibold">Need a hand?</h2>
          <p className="mt-2 text-sm leading-6 text-slate-300">Your PRISIM account representative can help with workspace access and onboarding.</p>
          <a href="mailto:support@prisim.in" className="mt-5 inline-flex text-sm font-medium text-accent-100 hover:text-white">Contact support</a>
        </Card>
      </div>

      {membership && (
        <p className="text-xs text-slate-400">
          You’re signed in with <span className="capitalize">{membership.role}</span> access. Your workspace data is protected by database-level tenant policies.
        </p>
      )}
    </div>
  );
}

function SetupLink({ icon, title, description, href }: { icon: ReactNode; title: string; description: string; href: string }) {
  return (
    <Link to={href} className="group border-b border-slate-100 p-5 transition hover:bg-slate-50 last:border-b-0 sm:border-b-0 sm:border-r sm:p-6 sm:last:border-r-0">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-50 text-accent-700 [&>svg]:h-[18px] [&>svg]:w-[18px]">{icon}</span>
      <h3 className="mt-4 flex items-center gap-1.5 text-sm font-semibold text-ink-950">
        {title} <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 text-slate-400 transition group-hover:text-accent-700" />
      </h3>
      <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>
    </Link>
  );
}
