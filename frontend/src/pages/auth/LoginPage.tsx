import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, Eye, EyeOff, LockKeyhole, Mail } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Field } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { AuthShell } from "../../components/auth/AuthShell";
import { useAuth } from "../../context/AuthProvider";
import { signInSchema, type SignInValues } from "../../lib/validation";

type LoginLocationState = {
  from?: { pathname?: string };
  invitationToken?: string;
};

export function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [formError, setFormError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const state = location.state as LoginLocationState | null;
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInValues>({ resolver: zodResolver(signInSchema) });

  const onSubmit = handleSubmit(async ({ email, password }) => {
    setFormError(null);
    try {
      await signIn(email, password);
      if (state?.invitationToken) {
        navigate("/accept-invite", {
          replace: true,
          state: { invitationToken: state.invitationToken },
        });
      } else {
        navigate(state?.from?.pathname ?? "/", { replace: true });
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "We couldn't sign you in. Try again.");
    }
  });

  return (
    <AuthShell>
      <div className="mb-8">
        <p className="text-sm font-semibold text-accent-700">Welcome back</p>
        <h2 className="mt-2 text-3xl font-semibold tracking-tight text-ink-950">Sign in to your account</h2>
        <p className="mt-3 text-sm leading-6 text-slate-500">
          Use the email address associated with your PRISIM account.
        </p>
      </div>

      {formError && <Alert tone="error" className="mb-5">{formError}</Alert>}

      <form className="space-y-5" onSubmit={onSubmit} noValidate>
        <Field label="Email address" htmlFor="email" error={errors.email?.message}>
          <div className="relative">
            <Mail aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              className="pl-10"
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? "email-error" : undefined}
              {...register("email")}
            />
          </div>
        </Field>
        <Field label="Password" htmlFor="password" error={errors.password?.message}>
          <div className="relative">
            <LockKeyhole aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              placeholder="Enter your password"
              className="pl-10 pr-11"
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? "password-error" : undefined}
              {...register("password")}
            />
            <button
              type="button"
              onClick={() => setShowPassword((visible) => !visible)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            >
              {showPassword ? <EyeOff aria-hidden="true" className="h-4 w-4" /> : <Eye aria-hidden="true" className="h-4 w-4" />}
            </button>
          </div>
        </Field>
        <div className="-mt-1 flex justify-end">
          <Link to="/forgot-password" className="text-sm font-medium text-accent-700 hover:text-accent-800">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" className="w-full" loading={isSubmitting}>
          Sign in <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </Button>
      </form>

      <div className="mt-7 border-t border-slate-100 pt-5 text-center text-sm text-slate-500">
        Access is by invitation only.{" "}
        <span className="font-medium text-slate-700">Contact your PRISIM administrator</span> if you need an account.
      </div>
    </AuthShell>
  );
}
