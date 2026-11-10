import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Session, User } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { friendlyAuthError } from "../lib/auth-errors";
import { parseAuthContext, type AuthContextData, type TenantMembership, type UserProfile } from "../lib/auth-context";
import type { Database } from "../lib/database";

type AuthSnapshot = {
  context: AuthContextData;
  profile: UserProfile | null;
};

type AuthActions = {
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  updatePassword: (password: string) => Promise<void>;
  acceptInvitation: (token: string) => Promise<void>;
  refreshContext: () => Promise<void>;
  setCurrentTenant: (tenantId: string) => void;
};

export type AuthState = AuthActions & {
  supabase: SupabaseClient<Database>;
  user: User | null;
  session: Session | null;
  isAuthenticated: boolean;
  authLoading: boolean;
  contextLoading: boolean;
  contextError: string | null;
  context: AuthContextData | null;
  profile: UserProfile | null;
  memberships: TenantMembership[];
  currentTenant: TenantMembership | null;
  platformRole: "platform_admin" | null;
};

const AuthContext = createContext<AuthState | null>(null);

type AuthProviderProps = PropsWithChildren<{
  supabase: SupabaseClient<Database>;
  appUrl: string;
}>;

async function loadAuthSnapshot(
  supabase: SupabaseClient<Database>,
  authenticatedUserId: string,
): Promise<AuthSnapshot> {
  const [contextResult, profileResult] = await Promise.all([
    supabase.rpc("get_my_context"),
    supabase
      .from("profiles")
      .select("id, full_name, avatar_url")
      .eq("id", authenticatedUserId)
      .maybeSingle(),
  ]);

  if (contextResult.error || profileResult.error) {
    throw new Error(
      "Your account access could not be loaded. Confirm that migration 20261105120000_security_hardening.sql is applied, then try again.",
    );
  }

  return {
    context: parseAuthContext(contextResult.data, authenticatedUserId),
    profile: profileResult.data,
  };
}

export function AuthProvider({ children, supabase, appUrl }: AuthProviderProps) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [currentTenantId, setCurrentTenantId] = useState<string | null>(null);
  const user = session?.user ?? null;

  useEffect(() => {
    let active = true;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      setSession(nextSession);
      setAuthError(null);
      setAuthLoading(false);
    });

    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) {
        setAuthError("We couldn't restore your session. Refresh the page to try again.");
      }
      setSession(data.session);
      setAuthLoading(false);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  const contextQuery = useQuery({
    queryKey: ["auth-context", user?.id],
    queryFn: () => loadAuthSnapshot(supabase, user!.id),
    enabled: Boolean(user) && !authLoading,
    retry: false,
    staleTime: 0,
  });

  const context = contextQuery.data?.context ?? null;
  const memberships = context?.memberships ?? [];
  const currentTenant = memberships.find((membership) => membership.tenant_id === currentTenantId) ?? null;

  useEffect(() => {
    if (!context) {
      setCurrentTenantId(null);
      return;
    }
    if (!memberships.some((membership) => membership.tenant_id === currentTenantId)) {
      setCurrentTenantId(memberships.find((membership) => membership.tenant_status === "active")?.tenant_id ?? memberships[0]?.tenant_id ?? null);
    }
  }, [context, memberships, currentTenantId]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw new Error(friendlyAuthError(error, "sign-in"));
      setSession(data.session);
      setAuthError(null);
    },
    [supabase],
  );

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw new Error("We couldn't sign you out. Please try again.");
    setSession(null);
    setCurrentTenantId(null);
    setAuthError(null);
    queryClient.removeQueries({ queryKey: ["auth-context"] });
  }, [queryClient, supabase]);

  const requestPasswordReset = useCallback(
    async (email: string) => {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${appUrl}/reset-password`,
      });
      if (error) throw new Error(friendlyAuthError(error, "recovery"));
    },
    [appUrl, supabase],
  );

  const updatePassword = useCallback(
    async (password: string) => {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw new Error(friendlyAuthError(error, "password"));
    },
    [supabase],
  );

  const acceptInvitation = useCallback(
    async (token: string) => {
      const { error } = await supabase.rpc("accept_invitation", { p_token: token });
      if (error) {
        throw new Error(
          "We couldn't accept this invitation. Confirm you are signed in with the invited, verified email address and that the invitation is still valid.",
        );
      }
    },
    [supabase],
  );

  const refreshContext = useCallback(async () => {
    if (!user) return;
    await queryClient.invalidateQueries({ queryKey: ["auth-context", user.id] });
  }, [queryClient, user]);

  const setCurrentTenant = useCallback(
    (tenantId: string) => {
      if (memberships.some((membership) => membership.tenant_id === tenantId)) {
        setCurrentTenantId(tenantId);
      }
    },
    [memberships],
  );

  const value = useMemo<AuthState>(
    () => ({
      supabase,
      user,
      session,
      isAuthenticated: Boolean(user),
      authLoading,
      contextLoading: authLoading || (Boolean(user) && contextQuery.isLoading),
      contextError: authError ?? (contextQuery.error instanceof Error ? contextQuery.error.message : null),
      context,
      profile: contextQuery.data?.profile ?? null,
      memberships,
      currentTenant,
      platformRole: context?.is_platform_admin ? "platform_admin" : null,
      signIn,
      signOut,
      requestPasswordReset,
      updatePassword,
      acceptInvitation,
      refreshContext,
      setCurrentTenant,
    }),
    [
      authError,
      authLoading,
      acceptInvitation,
      context,
      contextQuery.data,
      contextQuery.error,
      contextQuery.isLoading,
      currentTenant,
      memberships,
      refreshContext,
      requestPasswordReset,
      supabase,
      session,
      setCurrentTenant,
      signIn,
      signOut,
      updatePassword,
      user,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider.");
  return value;
}
