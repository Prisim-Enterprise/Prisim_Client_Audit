import { AlertTriangle, Inbox, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { errorMessage } from "../../lib/api/errors";
import { cn } from "../../lib/utils";
import { Button } from "./Button";
import { Card } from "./Card";
import { LoadingState } from "./LoadingState";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <p className="text-sm font-medium text-accent-700">{eyebrow}</p>}
        <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-ink-950 sm:text-3xl">{title}</h1>
        {description && <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </section>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-500 [&>svg]:h-5 [&>svg]:w-5">
        {icon ?? <Inbox aria-hidden="true" />}
      </div>
      <h3 className="mt-4 text-sm font-semibold text-ink-950">{title}</h3>
      {description && <p className="mt-1.5 max-w-md text-sm leading-6 text-slate-500">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center px-6 py-10 text-center", className)}>
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-rose-50 text-rose-600">
        <AlertTriangle aria-hidden="true" className="h-5 w-5" />
      </div>
      <h3 className="mt-4 text-sm font-semibold text-ink-950">This couldn't be loaded</h3>
      <p className="mt-1.5 max-w-md text-sm leading-6 text-slate-500">{errorMessage(error)}</p>
      {onRetry && (
        <Button className="mt-5" size="small" variant="secondary" onClick={onRetry}>
          <RefreshCw aria-hidden="true" className="h-4 w-4" /> Try again
        </Button>
      )}
    </div>
  );
}

/** Renders loading / error / empty / content for a React Query result. */
export function QueryView<T>({
  query,
  empty,
  isEmpty,
  children,
  loadingLabel,
}: {
  query: { data: T | undefined; isLoading: boolean; error: unknown; refetch: () => unknown };
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
  loadingLabel?: string;
}) {
  if (query.isLoading) return <LoadingState label={loadingLabel ?? "Loading…"} />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (query.data === undefined) return null;
  if (empty && (isEmpty ? isEmpty(query.data) : Array.isArray(query.data) && query.data.length === 0)) return <>{empty}</>;
  return <>{children(query.data)}</>;
}

export function StatTile({
  label,
  value,
  detail,
  icon,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  tone?: "default" | "warning" | "danger";
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-slate-500">{label}</p>
          <p className={cn("mt-2 truncate text-2xl font-semibold tracking-tight", tone === "danger" ? "text-rose-700" : tone === "warning" ? "text-amber-700" : "text-ink-950")}>
            {value}
          </p>
        </div>
        {icon && <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-50 text-accent-700 [&>svg]:h-5 [&>svg]:w-5">{icon}</span>}
      </div>
      {detail && <p className="mt-2 text-xs leading-5 text-slate-500">{detail}</p>}
    </Card>
  );
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card className={cn("overflow-hidden", className)}>
      <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="min-w-0">
          <h2 className="font-semibold text-ink-950">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className={bodyClassName}>{children}</div>
    </Card>
  );
}
