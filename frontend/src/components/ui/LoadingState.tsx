import { LoaderCircle } from "lucide-react";

export function LoadingState({ label = "Loading your workspace…" }: { label?: string }) {
  return (
    <div className="flex min-h-56 items-center justify-center gap-3 text-sm text-slate-500" role="status">
      <LoaderCircle aria-hidden="true" className="h-5 w-5 animate-spin text-accent-600" />
      <span>{label}</span>
    </div>
  );
}
