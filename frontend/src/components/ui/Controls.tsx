import { ChevronDown } from "lucide-react";
import { forwardRef, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "./Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./Dialog";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          "min-h-10 w-full appearance-none rounded-lg border border-slate-200 bg-white py-2 pl-3 pr-9 text-sm text-ink-950 shadow-sm outline-none transition focus:border-accent-500 focus:ring-4 focus:ring-accent-100 disabled:bg-slate-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "min-h-24 w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-ink-950 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-accent-500 focus:ring-4 focus:ring-accent-100 disabled:bg-slate-50",
        className,
      )}
      {...props}
    />
  );
});

export function Tabs<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  items: Array<{ value: T; label: string; count?: number }>;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-slate-200">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={value === item.value}
          onClick={() => onChange(item.value)}
          className={cn(
            "-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500",
            value === item.value ? "border-accent-600 text-accent-700" : "border-transparent text-slate-500 hover:text-ink-950",
          )}
        >
          {item.label}
          {item.count !== undefined && <span className="rounded-full bg-slate-100 px-1.5 text-xs text-slate-600">{item.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function ConfirmButton({
  title,
  description,
  confirmLabel,
  onConfirm,
  children,
  variant = "secondary",
  confirmVariant = "danger",
  size = "small",
  disabled,
}: {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<unknown> | unknown;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  confirmVariant?: "primary" | "danger";
  size?: "default" | "small";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  return (
    <>
      <Button type="button" size={size} variant={variant} disabled={disabled} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !working && setOpen(next)}>
        <DialogContent>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild><div>{description}</div></DialogDescription>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={working}>Cancel</Button>
            <Button
              variant={confirmVariant}
              loading={working}
              onClick={async () => {
                setWorking(true);
                try {
                  await onConfirm();
                  setOpen(false);
                } finally {
                  setWorking(false);
                }
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
