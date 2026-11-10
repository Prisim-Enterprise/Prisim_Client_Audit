import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, MailCheck } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router-dom";
import { AuthShell } from "../../components/auth/AuthShell";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Field } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { useAuth } from "../../context/AuthProvider";
import { recoverySchema, type RecoveryValues } from "../../lib/validation";

export function ForgotPasswordPage() {
  const { requestPasswordReset } = useAuth();
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RecoveryValues>({ resolver: zodResolver(recoverySchema) });

  const onSubmit = handleSubmit(async ({ email }) => {
    setFormError(null);
    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "We couldn't send a recovery email.");
    }
  });

  return (
    <AuthShell eyebrow="Account recovery">
      {sent ? (
        <div>
          <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl bg-accent-50 text-accent-700">
            <MailCheck aria-hidden="true" className="h-6 w-6" />
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-ink-950">Check your inbox</h1>
          <p className="mt-3 text-sm leading-6 text-slate-500">
            If an account matches that email address, a password reset link is on its way.
          </p>
          <Link to="/login" className="mt-8 inline-flex items-center gap-2 text-sm font-medium text-accent-700 hover:text-accent-800">
            <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Back to sign in
          </Link>
        </div>
      ) : (
        <>
          <div className="mb-8">
            <Link to="/login" className="mb-7 inline-flex items-center gap-2 text-sm text-slate-500 hover:text-ink-950">
              <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Back to sign in
            </Link>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-ink-950">Reset your password</h1>
            <p className="mt-3 text-sm leading-6 text-slate-500">
              Enter your account email and we’ll send a secure reset link.
            </p>
          </div>
          {formError && <Alert tone="error" className="mb-5">{formError}</Alert>}
          <form onSubmit={onSubmit} className="space-y-5" noValidate>
            <Field label="Email address" htmlFor="email" error={errors.email?.message}>
              <Input id="email" type="email" autoComplete="email" placeholder="you@company.com" {...register("email")} />
            </Field>
            <Button type="submit" loading={isSubmitting} className="w-full">Send reset link</Button>
          </form>
        </>
      )}
    </AuthShell>
  );
}
