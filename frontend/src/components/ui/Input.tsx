import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3.5 text-sm text-ink-950 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-accent-500 focus:ring-4 focus:ring-accent-100 disabled:bg-slate-50",
        className,
      )}
      {...props}
    />
  );
});
