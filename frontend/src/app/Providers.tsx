import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type PropsWithChildren } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Toaster } from "sonner";
import type { Database } from "../lib/database";
import { AuthProvider } from "../context/AuthProvider";

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

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider supabase={supabase} appUrl={appUrl}>
        {children}
        <Toaster position="top-right" richColors closeButton />
      </AuthProvider>
    </QueryClientProvider>
  );
}
