import { CheckCircle2, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/auth/AuthShell";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { LoadingState } from "../../components/ui/LoadingState";
import { useAuth } from "../../context/AuthProvider";

type InviteLocationState = { invitationToken?: string };

function getStateToken(state: unknown): string | null {
  if (!state || typeof state !== "object" || !("invitationToken" in state)) return null;
  const token = (state as InviteLocationState).invitationToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

export function AcceptInvitePage() {
  const { user, authLoading, contextLoading, acceptInvitation, refreshContext, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [token, setToken] = useState<string | null>(() => getStateToken(location.state));
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (token) return;
    const search = new URLSearchParams(location.search);
    const queryToken = search.get("token");
    const fragment = new URLSearchParams(location.hash.slice(1));
    const inviteToken = queryToken ?? fragment.get("token");
    if (inviteToken) setToken(inviteToken);
    if (queryToken) search.delete("token");
    if (location.hash || queryToken) {
      const cleanSearch = search.toString();
      window.history.replaceState(
        window.history.state,
        "",
        `${location.pathname}${cleanSearch ? `?${cleanSearch}` : ""}`,
      );
    }
  }, [location.hash, location.pathname, location.search, token]);

  const accept = async () => {
    if (!token || !user || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await acceptInvitation(token);
      setToken(null);
      setAccepted(true);
      await refreshContext();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We couldn't accept this invitation.");
    } finally {
      setSubmitting(false);
    }
  };

  const switchAccount = async () => {
    try {
      await signOut();
      navigate("/login", { replace: true, state: { invitationToken: token } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We couldn't sign you out.");
    }
  };

  if (authLoading || (user && contextLoading)) {
    return <AuthShell eyebrow="Client onboarding"><LoadingState label="Checking your invitation…" /></AuthShell>;
  }

  if (accepted) {
    return (
      <AuthShell eyebrow="Client onboarding">
        <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl bg-accent-50 text-accent-700">
          <CheckCircle2 aria-hidden="true" className="h-6 w-6" />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-ink-950">You’re all set</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">Your invitation has been accepted. Your workspace is ready.</p>
        <Button className="mt-7 w-full" onClick={() => navigate("/", { replace: true })}>Open your workspace</Button>
      </AuthShell>
    );
  }

  if (!token) {
    return (
      <AuthShell eyebrow="Client onboarding">
        <h1 className="text-3xl font-semibold tracking-tight text-ink-950">Invitation link unavailable</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">
          This link is missing or incomplete. Open the full invitation link or ask your administrator to send a new one.
        </p>
        <Link to="/login" className="mt-7 inline-flex text-sm font-semibold text-accent-700 hover:text-accent-800">Back to sign in</Link>
      </AuthShell>
    );
  }

  if (!user) {
    return (
      <AuthShell eyebrow="Client onboarding">
        <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl bg-accent-50 text-accent-700">
          <KeyRound aria-hidden="true" className="h-6 w-6" />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-ink-950">Accept your invitation</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">
          Sign in with the email address this invitation was sent to. The invitation token has been removed from the address bar.
        </p>
        <Link
          to="/login"
          state={{ invitationToken: token }}
          className="mt-7 inline-flex w-full items-center justify-center rounded-lg bg-accent-600 px-4 py-3 text-sm font-semibold text-white hover:bg-accent-700"
        >
          Continue to sign in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell eyebrow="Client onboarding">
      <h1 className="text-3xl font-semibold tracking-tight text-ink-950">Accept your invitation</h1>
      <p className="mt-3 text-sm leading-6 text-slate-500">
        Signed in as <span className="font-medium text-slate-700">{user.email}</span>. Continue to join your client workspace.
      </p>
      {error && <Alert tone="error" className="mt-5">{error}</Alert>}
      <Button className="mt-7 w-full" loading={submitting} onClick={() => void accept()}>
        Accept invitation
      </Button>
      <button
        type="button"
        onClick={() => void switchAccount()}
        className="mt-4 w-full text-center text-sm text-slate-500 hover:text-ink-950"
      >
        Sign out and use another account
      </button>
    </AuthShell>
  );
}
