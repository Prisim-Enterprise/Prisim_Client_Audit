import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeOff, LockKeyhole } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router-dom";
import { AuthShell } from "../../components/auth/AuthShell";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Field } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { useAuth } from "../../context/AuthProvider";
import { friendlyAuthError } from "../../lib/auth-errors";
import { resetPasswordSchema, type ResetPasswordValues } from "../../lib/validation";

export function ResetPasswordPage() {
  const { user, authLoading, updatePassword } = useAuth();
  const [formError, setFormError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [visible, setVisible] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordValues>({ resolver: zodResolver(resetPasswordSchema) });

  if (authLoading) return null;
  if (!user && !complete) {
    return (
      <AuthShell eyebrow="Account recovery">
        <h1 className="text-3xl font-semibold tracking-tight text-ink-950">Reset link unavailable</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">
          This link may have expired or already been used. Request a fresh reset link to continue.
        </p>
        <Link to="/forgot-password" className="mt-7 inline-flex text-sm font-semibold text-accent-700 hover:text-accent-800">
          Request another link
        </Link>
      </AuthShell>
    );
  }
  if (complete) {
    return (
      <AuthShell eyebrow="Account recovery">
        <h1 className="text-3xl font-semibold tracking-tight text-ink-950">Password updated</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">Your password is ready. Sign in with your new credentials.</p>
        <Link to="/" className="mt-7 inline-flex text-sm font-semibold text-accent-700 hover:text-accent-800">
          Continue to your portal
        </Link>
      </AuthShell>
    );
  }

  const onSubmit = handleSubmit(async ({ password }) => {
    setFormError(null);
    try {
      await updatePassword(password);
      setComplete(true);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : friendlyAuthError(error, "password"));
    }
  });

  return (
    <AuthShell eyebrow="Account recovery">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight text-ink-950">Choose a new password</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">
          Use at least 10 characters with an uppercase letter, a lowercase letter, and a number.
        </p>
      </div>
      {formError && <Alert tone="error" className="mb-5">{formError}</Alert>}
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        <Field label="New password" htmlFor="password" error={errors.password?.message}>
          <div className="relative">
            <LockKeyhole aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              id="password"
              type={visible ? "text" : "password"}
              autoComplete="new-password"
              className="pl-10 pr-11"
              {...register("password")}
            />
            <button
              type="button"
              onClick={() => setVisible((value) => !value)}
              aria-label={visible ? "Hide password" : "Show password"}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            >
              {visible ? <EyeOff aria-hidden="true" className="h-4 w-4" /> : <Eye aria-hidden="true" className="h-4 w-4" />}
            </button>
          </div>
        </Field>
        <Field label="Confirm new password" htmlFor="confirmPassword" error={errors.confirmPassword?.message}>
          <Input id="confirmPassword" type={visible ? "text" : "password"} autoComplete="new-password" {...register("confirmPassword")} />
        </Field>
        <Button type="submit" className="w-full" loading={isSubmitting}>Update password</Button>
      </form>
    </AuthShell>
  );
}
