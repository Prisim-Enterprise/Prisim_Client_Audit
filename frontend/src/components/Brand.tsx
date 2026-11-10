import { Aperture } from "lucide-react";
import { cn } from "../lib/utils";

export function Brand({ light = false, compact = false }: { light?: boolean; compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className={cn("flex h-10 w-10 items-center justify-center rounded-xl", light ? "bg-white/10 text-accent-100" : "bg-accent-50 text-accent-700")}>
        <Aperture aria-hidden="true" className="h-5 w-5" strokeWidth={2.2} />
      </div>
      {!compact && (
        <div className={light ? "text-white" : "text-ink-950"}>
          <div className="text-sm font-bold tracking-[0.16em]">PRISIM</div>
          <div className={cn("mt-0.5 text-[11px] tracking-wide", light ? "text-slate-300" : "text-slate-500")}>
            CLIENT AUDIT PORTAL
          </div>
        </div>
      )}
    </div>
  );
}
