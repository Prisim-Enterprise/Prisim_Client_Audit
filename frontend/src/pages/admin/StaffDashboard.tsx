import { ArrowUpRight, Building2, CircleCheck, KeyRound, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Card } from "../../components/ui/Card";
import { useAuth } from "../../context/AuthProvider";

export function StaffDashboard() {
  const { user, profile, memberships } = useAuth();
  const name = profile?.full_name?.trim().split(/\s+/)[0] || user?.email?.split("@")[0] || "there";

  return (
    <div className="space-y-8">
      <section className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-accent-700">Staff workspace</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink-950">Good to see you, {name}</h1>
          <p className="mt-2 text-sm text-slate-500">Your PRISIM operations workspace is ready.</p>
        </div>
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800">
          <CircleCheck aria-hidden="true" className="h-4 w-4" /> Secure staff session
        </span>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <SummaryCard icon={<ShieldCheck />} label="Access level" value="Platform administrator" detail="Verified with multi-factor authentication" />
        <SummaryCard icon={<Building2 />} label="Your client memberships" value={String(memberships.length)} detail="Based on your assigned tenant memberships" />
        <SummaryCard icon={<KeyRound />} label="Data authorization" value="Database enforced" detail="Tenant access is controlled by PostgreSQL RLS" />
      </section>

      <Card className="overflow-hidden">
        <div className="border-b border-slate-100 px-6 py-5 sm:px-7">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Getting started</p>
          <h2 className="mt-2 text-lg font-semibold text-ink-950">The foundation is in place</h2>
          <p className="mt-1 text-sm text-slate-500">Client operations will appear as the next product workflows are connected.</p>
        </div>
        <div className="grid divide-y divide-slate-100 md:grid-cols-3 md:divide-x md:divide-y-0">
          <WorkItem step="01" title="Client workspaces" description="Review the clients assigned to your staff account." href="/admin/clients" />
          <WorkItem step="02" title="Ad platform connections" description="Meta and Google connection workflows are being prepared." href="/admin/connections" />
          <WorkItem step="03" title="Audit reviews" description="Review findings and reports as those workflows come online." href="/admin/audits" />
        </div>
      </Card>
    </div>
  );
}

function SummaryCard({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-slate-500">{label}</p>
          <p className="mt-3 text-xl font-semibold tracking-tight text-ink-950">{value}</p>
        </div>
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-50 text-accent-700 [&>svg]:h-5 [&>svg]:w-5">{icon}</span>
      </div>
      <p className="mt-3 text-xs leading-5 text-slate-500">{detail}</p>
    </Card>
  );
}

function WorkItem({ step, title, description, href }: { step: string; title: string; description: string; href: string }) {
  return (
    <Link to={href} className="group p-6 transition-colors hover:bg-slate-50 sm:p-7">
      <p className="text-xs font-semibold tracking-[0.12em] text-accent-700">{step}</p>
      <div className="mt-4 flex items-center justify-between gap-3">
        <h3 className="font-semibold text-ink-950">{title}</h3>
        <ArrowUpRight aria-hidden="true" className="h-4 w-4 text-slate-400 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-accent-700" />
      </div>
      <p className="mt-2 text-sm leading-6 text-slate-500">{description}</p>
    </Link>
  );
}
