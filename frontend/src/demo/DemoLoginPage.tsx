import { Building2, Eye, ShieldCheck, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { AuthShell } from "../components/auth/AuthShell";
import { type DemoPersona, useDemoPersona } from "./DemoRoot";

export function DemoLoginPage() {
  const { choose } = useDemoPersona();
  const navigate = useNavigate();
  const pick = (persona: DemoPersona) => {
    choose(persona);
    navigate("/", { replace: true });
  };
  return (
    <AuthShell eyebrow="Demo mode">
      <div>
        <div className="flex gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3.5 text-sm text-amber-900" role="status">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <b>Synthetic demo data.</b> Every business, account and number in this mode is generated and is not a real client result.
            No Supabase project is contacted and nothing is saved.
          </p>
        </div>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight text-ink-950">Explore the portal</h1>
        <p className="mt-2 text-sm text-slate-500">Choose a persona. You can sign out and switch at any time.</p>
        <div className="mt-6 space-y-3">
          <Persona icon={<ShieldCheck />} title="PRISIM staff" description="Manage clients, connections, run and review audits, generate reports." onClick={() => pick("staff")} />
          <Persona icon={<Building2 />} title="Client owner" description="Northwind Dental (Demo): connect ad accounts, analytics, audits, reports, team." onClick={() => pick("owner")} />
          <Persona icon={<Eye />} title="Client viewer" description="Read-only access to the same workspace." onClick={() => pick("viewer")} />
        </div>
      </div>
    </AuthShell>
  );
}

function Persona({ icon, title, description, onClick }: { icon: ReactNode; title: string; description: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-4 rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:border-accent-500 hover:bg-accent-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-50 text-accent-700 [&>svg]:h-5 [&>svg]:w-5">{icon}</span>
      <span>
        <span className="block font-semibold text-ink-950">{title}</span>
        <span className="mt-0.5 block text-sm leading-5 text-slate-500">{description}</span>
      </span>
    </button>
  );
}
