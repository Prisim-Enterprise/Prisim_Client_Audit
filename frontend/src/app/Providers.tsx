import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type PropsWithChildren } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Toaster } from "sonner";
import type { Database } from "../lib/database";
import { AuthProvider } from "../context/AuthProvider";
import { ApiProvider } from "../lib/api/ApiProvider";
import { createSupabaseApi } from "../lib/api/supabase-api";

export function Providers({
  children,
  supabase,
  appUrl,
}: PropsWithChildren<{ supabase: SupabaseClient<Database>; appUrl: string }>) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { refetchOnWindowFocus: true, retry: 1 },
          mutations: { retry: false },
        },
      }),
  );

  const [api] = useState(() => createSupabaseApi(supabase));

  return (
    <QueryClientProvider client={queryClient}>
      <ApiProvider api={api}>
        <AuthProvider supabase={supabase} appUrl={appUrl}>
          {children}
          <Toaster position="top-right" richColors closeButton />
        </AuthProvider>
      </ApiProvider>
    </QueryClientProvider>
  );
}
