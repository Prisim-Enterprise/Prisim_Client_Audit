// Demo mode root: synthetic personas and the in-memory API. Loaded only when
// Vite runs with `--mode demo`; production builds never include this module.

import type { User } from "@supabase/supabase-js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useMemo, useRef, useState, type PropsWithChildren } from "react";
import { Toaster } from "sonner";
import { App } from "../app/App";
import { AuthContext, type AuthState } from "../context/AuthProvider";
import { ApiProvider } from "../lib/api/ApiProvider";
import type { AuthContextData } from "../lib/auth-context";
import { createDemoApi } from "./demo-api";
import { DEMO_TENANT_IDS, DEMO_USERS } from "./fixtures";

export type DemoPersona = "staff" | "owner" | "viewer";

const PERSONAS: Record<DemoPersona, { user: { id: string; email: string; name: string }; context: (id: string) => AuthContextData }> = {
  staff: {
    user: DEMO_USERS.staff,
    context: (id) => ({ user_id: id, is_platform_admin: true, platform_admin_mfa_required: false, memberships: [] }),
  },
  owner: {
    user: DEMO_USERS.owner,
    context: (id) => ({
      user_id: id,
      is_platform_admin: false,
      platform_admin_mfa_required: false,
      memberships: [{ tenant_id: DEMO_TENANT_IDS.northwind, business_name: "Northwind Dental (Demo)", slug: "northwind-dental-demo", tenant_status: "active", role: "owner" }],
    }),
  },
  viewer: {
    user: DEMO_USERS.viewer,
    context: (id) => ({
      user_id: id,
      is_platform_admin: false,
      platform_admin_mfa_required: false,
      memberships: [{ tenant_id: DEMO_TENANT_IDS.northwind, business_name: "Northwind Dental (Demo)", slug: "northwind-dental-demo", tenant_status: "active", role: "viewer" }],
    }),
  },
};

const PersonaContext = createContext<{ choose: (persona: DemoPersona) => void } | null>(null);

export function useDemoPersona() {
  const value = useContext(PersonaContext);
  if (!value) throw new Error("Demo persona context missing.");
  return value;
}

const notAvailable = async () => {
  throw new Error("Not available in demo mode.");
};

function DemoAuth({ children }: PropsWithChildren) {
  const [persona, setPersona] = useState<DemoPersona | null>(null);
  const personaRef = useRef<DemoPersona | null>(null);
  personaRef.current = persona;
  const [api] = useState(() =>
    createDemoApi({
      actorId: () => (personaRef.current ? PERSONAS[personaRef.current].user.id : DEMO_USERS.staff.id),
      actorEmail: () => (personaRef.current ? PERSONAS[personaRef.current].user.email : DEMO_USERS.staff.email),
    })
  );

  const value = useMemo<AuthState>(() => {
    const selected = persona ? PERSONAS[persona] : null;
    const context = selected ? selected.context(selected.user.id) : null;
    const user = selected
      ? ({ id: selected.user.id, email: selected.user.email, app_metadata: {}, user_metadata: {}, aud: "authenticated", created_at: "2026-08-01T00:00:00Z" } as User)
      : null;
    return {
      supabase: null,
      demo: true,
      user,
      session: null,
      isAuthenticated: Boolean(user),
      authLoading: false,
      contextLoading: false,
      contextError: null,
      context,
      profile: selected ? { id: selected.user.id, full_name: selected.user.name, avatar_url: null } : null,
      memberships: context?.memberships ?? [],
      currentTenant: context?.memberships[0] ?? null,
      platformRole: context?.is_platform_admin ? "platform_admin" : null,
      signIn: notAvailable,
      signOut: async () => setPersona(null),
      requestPasswordReset: notAvailable,
      updatePassword: notAvailable,
      acceptInvitation: notAvailable,
      refreshContext: async () => undefined,
      setCurrentTenant: () => undefined,
    };
  }, [persona]);

  return (
    <PersonaContext.Provider value={{ choose: setPersona }}>
      <ApiProvider api={api}>
        <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
      </ApiProvider>
    </PersonaContext.Provider>
  );
}

export function DemoRoot() {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 0, refetchOnWindowFocus: false } } }));
  return (
    <QueryClientProvider client={queryClient}>
      <DemoAuth>
        <App />
        <Toaster position="top-right" richColors closeButton />
      </DemoAuth>
    </QueryClientProvider>
  );
}
