import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

const tones = {
  neutral: "border-slate-200 bg-slate-50 text-slate-700",
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  danger: "border-rose-200 bg-rose-50 text-rose-800",
  info: "border-sky-200 bg-sky-50 text-sky-800",
  accent: "border-accent-100 bg-accent-50 text-accent-700",
  dark: "border-ink-900 bg-ink-950 text-white",
};

export type BadgeTone = keyof typeof tones;

export function Badge({ tone = "neutral", children, className }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium", tones[tone], className)}>
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, BadgeTone> = {
  active: "success",
  connected: "success",
  completed: "success",
  ready: "success",
  published: "success",
  accepted: "success",
  resolved: "success",
  pending: "warning",
  processing: "info",
  generating: "info",
  in_review: "info",
  draft: "neutral",
  open: "neutral",
  internal: "neutral",
  client: "accent",
  inactive: "neutral",
  archived: "neutral",
  paused: "warning",
  invited: "warning",
  expired: "warning",
  suspended: "danger",
  revoked: "danger",
  failed: "danger",
  error: "danger",
  dismissed: "neutral",
  disabled: "danger",
  closed: "neutral",
  unknown: "neutral",
};

const STATUS_LABELS: Record<string, string> = {
  in_review: "In review",
  client: "Shared with client",
  internal: "Internal",
  manual_sync: "Manual",
  daily_sync: "Daily",
  backfill: "Backfill",
};

export function statusLabel(status: string) {
  return STATUS_LABELS[status] ?? status.replace(/_/g, " ").replace(/^\w/, (char) => char.toUpperCase());
}

export function StatusBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  const value = status ?? "unknown";
  return <Badge tone={STATUS_TONES[value.toLowerCase()] ?? "neutral"} className={className}>{statusLabel(value.toLowerCase())}</Badge>;
}

const SEVERITY_STYLES: Record<string, string> = {
  critical: "border-rose-300 bg-rose-600 text-white",
  high: "border-orange-200 bg-orange-50 text-orange-800",
  medium: "border-amber-200 bg-amber-50 text-amber-800",
  low: "border-sky-200 bg-sky-50 text-sky-800",
  info: "border-slate-200 bg-slate-50 text-slate-600",
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide", SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.info)}>
      {severity}
    </span>
  );
}

export function ProviderBadge({ provider }: { provider: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600">
      <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", provider === "meta" ? "bg-[#1877f2]" : "bg-[#34a853]")} />
      {provider === "meta" ? "Meta Ads" : provider === "google" ? "Google Ads" : provider}
    </span>
  );
}
