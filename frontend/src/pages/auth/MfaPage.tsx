import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, KeyRound, ShieldCheck } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { BaseSyntheticEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/auth/AuthShell";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Field } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { LoadingState } from "../../components/ui/LoadingState";
import { useAuth } from "../../context/AuthProvider";
import { totpSchema, type TotpValues } from "../../lib/validation";

type Factor = { id: string; status: string };

export function MfaPage({ bootstrapEnrollment = false }: { bootstrapEnrollment?: boolean }) {
  const { context, contextLoading, refreshContext, supabase } = useAuth();
  const navigate = useNavigate();
  const [factorId, setFactorId] = useState<string | null>(null);
  const [setupUri, setSetupUri] = useState<string | null>(null);
  const [loadingFactors, setLoadingFactors] = useState(true);
  const [working, setWorking] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [factorError, setFactorError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<TotpValues>({ resolver: zodResolver(totpSchema) });

  useEffect(() => {
    let active = true;
    void supabase.auth.mfa.listFactors().then(({ data, error }) => {
      if (!active) return;
      if (error) {
        setFactorError("We couldn't check your authenticator setup. Refresh the page to try again.");
      } else {
        const verified = data.totp.find((factor: Factor) => factor.status === "verified");
        if (verified) setFactorId(verified.id);
      }
      setLoadingFactors(false);
    });
    return () => {
      active = false;
    };
  }, [supabase]);

  if (contextLoading) return <AuthShell eyebrow="Secure access"><LoadingState label="Checking your access…" /></AuthShell>;
  if (!bootstrapEnrollment && !context?.platform_admin_mfa_required) return <Navigate to="/" replace />;

  const startSetup = async () => {
    setWorking(true);
    setFormError(null);
    try {
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "PRISIM authenticator",
        issuer: "PRISIM Client Audit Portal",
      });
      if (error || !data.totp?.uri) {
        throw new Error("We couldn't start authenticator setup. Please try again or contact your administrator.");
      }
      setFactorId(data.id);
      setSetupUri(data.totp.uri);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "We couldn't start authenticator setup.");
    } finally {
      setWorking(false);
    }
  };

  const onSubmit = handleSubmit(async ({ code }) => {
    if (!factorId) return;
    setWorking(true);
    setFormError(null);
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
      if (challengeError) throw new Error("We couldn't start verification. Check your connection and try again.");
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code,
      });
      if (verifyError) throw new Error("That code wasn't accepted. Check the code in your authenticator app and try again.");
      const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (assuranceError || assurance.currentLevel !== "aal2") {
        throw new Error("Verification did not complete. Sign in again and retry the authenticator code.");
      }
      if (bootstrapEnrollment) {
        await refreshContext();
        navigate("/", { replace: true });
      } else {
        await refreshContext();
        navigate("/admin", { replace: true });
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "We couldn't verify the authenticator code.");
      reset();
    } finally {
      setWorking(false);
    }
  });

  return (
    <AuthShell eyebrow="Secure access">
      <Link to="/login" className="mb-7 inline-flex items-center gap-2 text-sm text-slate-500 hover:text-ink-950">
        <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Back to sign in
      </Link>
      <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl bg-accent-50 text-accent-700">
        <ShieldCheck aria-hidden="true" className="h-6 w-6" />
      </div>
      <h1 className="text-3xl font-semibold tracking-tight text-ink-950">Verify it’s you</h1>
      <p className="mt-3 text-sm leading-6 text-slate-500">
        {bootstrapEnrollment
          ? "Authenticator setup does not grant staff or tenant access. PRISIM administrators must be assigned separately by the project owner."
          : "PRISIM staff access requires a verified authenticator. Your account permissions are confirmed by Supabase."}
      </p>

      {factorError && <Alert tone="error" className="mt-5">{factorError}</Alert>}
      {formError && <Alert tone="error" className="mt-5">{formError}</Alert>}

      {loadingFactors ? (
        <div className="mt-7"><LoadingState label="Checking authenticator…" /></div>
      ) : setupUri ? (
        <div className="mt-7 space-y-5">
          <div className="flex justify-center rounded-xl border border-slate-200 bg-white p-5">
            <QRCodeSVG value={setupUri} size={188} level="M" aria-label="Authenticator setup QR code" />
          </div>
          <Alert tone="info">
            Scan this QR code with an authenticator app. The setup code is shown only in this session; keep it private.
          </Alert>
          <CodeForm register={register} error={errors.code?.message} onSubmit={onSubmit} loading={working} />
        </div>
      ) : factorId ? (
        <div className="mt-7 space-y-5">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-slate-800">
              <KeyRound aria-hidden="true" className="h-4 w-4 text-accent-700" />
              Open your authenticator app
            </p>
            <p className="mt-1 text-xs leading-5 text-slate-500">Enter the current 6-digit code for your PRISIM account.</p>
          </div>
          <CodeForm register={register} error={errors.code?.message} onSubmit={onSubmit} loading={working} />
        </div>
      ) : (
        <div className="mt-7 space-y-4">
          <Alert tone="info">
            Set up an authenticator app to continue. This device will be required for PRISIM staff access.
          </Alert>
          <Button className="w-full" loading={working} onClick={() => void startSetup()}>
            Set up authenticator
          </Button>
        </div>
      )}
    </AuthShell>
  );
}

function CodeForm({
  register,
  error,
  onSubmit,
  loading,
}: {
  register: ReturnType<typeof useForm<TotpValues>>["register"];
  error?: string;
  onSubmit: (event?: BaseSyntheticEvent) => Promise<void>;
  loading: boolean;
}) {
  return (
    <form className="space-y-5" onSubmit={onSubmit} noValidate>
      <Field label="Authenticator code" htmlFor="code" error={error}>
        <Input
          id="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          maxLength={6}
          className="text-center text-lg tracking-[0.35em]"
          aria-invalid={Boolean(error)}
          {...register("code")}
        />
      </Field>
      <Button className="w-full" type="submit" loading={loading}>Verify and continue</Button>
    </form>
  );
}
