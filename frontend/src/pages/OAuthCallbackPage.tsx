import { CheckCircle2, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AuthShell } from "../components/auth/AuthShell";
import { Button } from "../components/ui/Button";
import { LoadingState } from "../components/ui/LoadingState";
import { useAuth } from "../context/AuthProvider";
import { OAUTH_RETURN_KEY } from "../features/connections/ConnectionsPanel";
import { useApi } from "../lib/api/ApiProvider";
import { errorMessage } from "../lib/api/errors";
import type { OAuthCompletion } from "../lib/api/types";

type State =
  | { phase: "working" }
  | { phase: "done"; result: OAuthCompletion; next: string }
  | { phase: "failed"; message: string; next: string };

function readReturnPath() {
  try {
    const value = sessionStorage.getItem(OAUTH_RETURN_KEY);
    sessionStorage.removeItem(OAUTH_RETURN_KEY);
    return value && value.startsWith("/") && !value.startsWith("//") ? value : null;
  } catch {
    return null;
  }
}

/**
 * OAuth redirect target (`${APP_URL}/oauth/callback`, registered with Meta
 * and Google). The code and signed state are sent once to the ad-connections
 * function, which exchanges the code server-side. Both are removed from the
 * address bar immediately.
 */
export function OAuthCallbackPage() {
  const api = useApi();
  const navigate = useNavigate();
  const { context, memberships } = useAuth();
  const started = useRef(false);
  const [state, setState] = useState<State>({ phase: "working" });

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const oauthState = params.get("state");
    const providerError = params.get("error") ?? params.get("error_reason");
    window.history.replaceState(null, "", "/oauth/callback");
    const stored = readReturnPath();

    const destination = (tenantId?: string) => {
      if (stored) return stored;
      if (context?.is_platform_admin && tenantId) return `/admin/clients/${tenantId}?tab=connections`;
      const membership = memberships.find((item) => item.tenant_id === tenantId) ?? memberships[0];
      return membership ? `/app/${membership.slug}/accounts` : "/";
    };

    if (providerError || !code || !oauthState) {
      setState({
        phase: "failed",
        message: providerError === "access_denied"
          ? "Access was not granted, so no account was connected."
          : "The ad platform did not return an authorization code. Start the connection again.",
        next: destination(),
      });
      return;
    }
    api.completeOAuth(code, oauthState).then(
      (result) => setState({ phase: "done", result, next: destination(result.tenantId) }),
      (error) => setState({ phase: "failed", message: errorMessage(error), next: destination() }),
    );
  }, [api, context, memberships]);

  return (
    <AuthShell eyebrow="Ad platform connection">
      {state.phase === "working" ? (
        <LoadingState label="Securely completing the connection…" />
      ) : state.phase === "done" ? (
        <div className="text-center">
          <CheckCircle2 aria-hidden="true" className="mx-auto h-10 w-10 text-accent-600" />
          <h1 className="mt-4 text-xl font-semibold text-ink-950">{state.result.provider === "meta" ? "Meta Ads" : "Google Ads"} connected</h1>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            {state.result.accountsDiscovered} ad account{state.result.accountsDiscovered === 1 ? "" : "s"} found. Choose which ones to sync on the next screen.
          </p>
          {state.result.warning && <p className="mt-2 text-sm text-amber-700">{state.result.warning}</p>}
          <Button className="mt-6 w-full" onClick={() => navigate(state.next, { replace: true })}>Choose ad accounts</Button>
        </div>
      ) : (
        <div className="text-center">
          <XCircle aria-hidden="true" className="mx-auto h-10 w-10 text-rose-600" />
          <h1 className="mt-4 text-xl font-semibold text-ink-950">Connection not completed</h1>
          <p className="mt-2 text-sm leading-6 text-slate-500">{state.message}</p>
          <Button className="mt-6 w-full" variant="secondary" onClick={() => navigate(state.next, { replace: true })}>Back to ad accounts</Button>
        </div>
      )}
    </AuthShell>
  );
}
