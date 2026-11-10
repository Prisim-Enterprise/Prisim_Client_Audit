import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database";
import type { PublicEnv } from "./env";

export function createSupabaseBrowserClient(env: PublicEnv) {
  return createClient<Database>(env.supabaseUrl, env.publishableKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      flowType: "pkce",
    },
  });
}
