import { forwardRef, type ButtonHTMLAttributes } from "react";
import { LoaderCircle } from "lucide-react";
import { cn } from "../../lib/utils";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "default" | "small";
  loading?: boolean;
};

const variants = {
  primary: "bg-accent-600 text-white shadow-sm hover:bg-accent-700 focus-visible:ring-accent-500",
  secondary: "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 focus-visible:ring-accent-500",
  ghost: "text-slate-600 hover:bg-slate-100 hover:text-ink-950 focus-visible:ring-accent-500",
  danger: "bg-rose-600 text-white hover:bg-rose-700 focus-visible:ring-rose-500",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", size = "default", loading = false, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-55",
        size === "small" && "min-h-8 px-3 text-sm",
        variants[variant],
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
});
