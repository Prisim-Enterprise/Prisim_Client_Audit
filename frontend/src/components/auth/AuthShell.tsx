import { ArrowUpRight, BarChart3, CheckCircle2, ShieldCheck } from "lucide-react";
import type { PropsWithChildren, ReactNode } from "react";
import { Brand } from "../Brand";

export function AuthShell({ children, eyebrow = "A clearer view of performance" }: PropsWithChildren<{ eyebrow?: string }>) {
  return (
    <main className="min-h-screen bg-white lg:grid lg:grid-cols-[minmax(380px,0.92fr)_1.08fr]">
      <aside className="relative hidden min-h-screen overflow-hidden bg-ink-950 px-12 py-10 text-white lg:flex lg:flex-col lg:justify-between xl:px-16">
        <div className="absolute -right-36 -top-20 h-[32rem] w-[32rem] rounded-full border border-white/[0.06]" />
        <div className="absolute -right-16 top-4 h-[23rem] w-[23rem] rounded-full border border-white/[0.08]" />
        <div className="absolute -right-4 top-20 h-[14rem] w-[14rem] rounded-full border border-white/[0.1]" />
        <div className="relative">
          <Brand light />
        </div>
        <div className="relative max-w-lg pb-8">
          <p className="mb-5 text-xs font-semibold uppercase tracking-[0.2em] text-accent-100/80">{eyebrow}</p>
          <h1 className="text-4xl font-semibold leading-[1.14] tracking-tight xl:text-5xl">
            Better decisions start with a better view.
          </h1>
          <p className="mt-6 max-w-md text-base leading-7 text-slate-300">
            One considered workspace for advertising performance, account health, and actionable audits.
          </p>
          <div className="mt-10 grid gap-3">
            <Feature icon={<BarChart3 />} title="Performance, in context" />
            <Feature icon={<ShieldCheck />} title="Your data stays yours" />
            <Feature icon={<CheckCircle2 />} title="Audits built for action" />
          </div>
          <a
            href="https://prisim.in"
            target="_blank"
            rel="noreferrer"
            className="mt-9 inline-flex items-center gap-2 text-sm text-slate-300 transition hover:text-white"
          >
            Discover PRISIM <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
          </a>
        </div>
        <p className="relative text-xs text-slate-500">© {new Date().getFullYear()} PRISIM. All rights reserved.</p>
      </aside>
      <section className="flex min-h-screen flex-col px-5 py-7 sm:px-10 lg:px-14 xl:px-20">
        <div className="lg:hidden">
          <Brand />
        </div>
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-[430px]">{children}</div>
        </div>
        <p className="text-center text-xs text-slate-400 lg:text-right">
          Secure access for PRISIM teams and clients
        </p>
      </section>
    </main>
  );
}

function Feature({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-3 text-sm text-slate-200">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.07] text-accent-100 [&>svg]:h-4 [&>svg]:w-4">
        {icon}
      </span>
      {title}
    </div>
  );
}
