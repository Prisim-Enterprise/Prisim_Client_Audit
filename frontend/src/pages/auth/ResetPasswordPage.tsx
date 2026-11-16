import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeOff, LockKeyhole } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/auth/AuthShell";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Field } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { LoadingState } from "../../components/ui/LoadingState";
import { useAuth } from "../../context/AuthProvider";
import { friendlyAuthError } from "../../lib/auth-errors";
import { resetPasswordSchema, type ResetPasswordValues } from "../../lib/validation";

type LinkState = "none" | "verifying" | "verified" | "failed";

/** Reads a single-use password link (?token_hash=…&type=recovery) once. */
function readLinkToken(search: string): string | null {
  const params = new URLSearchParams(search);
  const token = params.get("token_hash");
  return token && params.get("type") === "recovery" ? token : null;
}

/**
 * Sets a password for:
 *   - a new client account (password link issued by PRISIM staff), and
 *   - an existing account (staff-issued link or a reset e-mail).
 * Both carry a one-time token_hash. A PKCE reset (?code=…) is still handled
 * by the Supabase client before this page renders.
 */
export function ResetPasswordPage() {
  const { user, authLoading, updatePassword, verifyPasswordLink } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [linkState, setLinkState] = useState<LinkState>(() => (readLinkToken(location.search) ? "verifying" : "none"));
  const [linkError, setLinkError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [visible, setVisible] = useState(false);
  const consumed = useRef(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordValues>({ resolver: zodResolver(resetPasswordSchema) });

  useEffect(() => {
    const token = readLinkToken(location.search);
    if (!token || consumed.current) return;
    // The token works once: never verify twice (React StrictMode re-runs effects).
    consumed.current = true;
    // Remove the token from the address bar and history straight away.
    navigate(location.pathname, { replace: true });
    verifyPasswordLink(token)
      .then(() => setLinkState("verified"))
      .catch((error: unknown) => {
        setLinkError(error instanceof Error ? error.message : null);
        setLinkState("failed");
      });
  }, [location.pathname, location.search, navigate, verifyPasswordLink]);

  if (authLoading || linkState === "verifying") {
    return (
      <AuthShell eyebrow="Account access">
        <LoadingState label="Checking your password link…" />
      </AuthShell>
    );
  }
  if (complete) {
    return (
      <AuthShell eyebrow="Account access">
        <h1 className="text-3xl font-semibold tracking-tight text-ink-950">Password saved</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">You're signed in. From now on, sign in with your email address and this password.</p>
        <Link to="/" className="mt-7 inline-flex text-sm font-semibold text-accent-700 hover:text-accent-800">
          Continue to your portal
        </Link>
      </AuthShell>
    );
  }
  if (linkState === "failed" || !user) {
    return (
      <AuthShell eyebrow="Account access">
        <h1 className="text-3xl font-semibold tracking-tight text-ink-950">Password link unavailable</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">
          {linkError ?? "This link may have expired or already been used."} Your PRISIM team can send you a new link.
        </p>
        <div className="mt-7 flex flex-wrap gap-x-6 gap-y-3">
          <Link to="/login" className="inline-flex text-sm font-semibold text-accent-700 hover:text-accent-800">Back to sign in</Link>
          <Link to="/forgot-password" className="inline-flex text-sm font-medium text-slate-500 hover:text-ink-950">Request a reset email</Link>
        </div>
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
    <AuthShell eyebrow="Account access">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight text-ink-950">Choose your password</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">
          {user.email ? <>For <span className="font-medium text-ink-950">{user.email}</span>. </> : null}
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
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? "password-error" : undefined}
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
          <Input
            id="confirmPassword"
            type={visible ? "text" : "password"}
            autoComplete="new-password"
            aria-invalid={Boolean(errors.confirmPassword)}
            aria-describedby={errors.confirmPassword ? "confirmPassword-error" : undefined}
            {...register("confirmPassword")}
          />
        </Field>
        <Button type="submit" className="w-full" loading={isSubmitting}>Save password</Button>
      </form>
    </AuthShell>
  );
}
