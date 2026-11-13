// Supabase clients for Edge Functions (Deno only).
//   userClient(jwt)  - acts as the caller; RLS and SQL authorization apply
//   serviceClient()  - service_role; only for the service RPCs that require it

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { HttpError } from "./http.ts";

export type ServerConfig = {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey?: string;
};

export function readServerConfig(requireServiceRole: boolean): ServerConfig {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || (requireServiceRole && !serviceRoleKey)) {
    throw new HttpError(500, "server_configuration_error");
  }
  return { supabaseUrl, anonKey, serviceRoleKey };
}

const options = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };

export function userClient(config: ServerConfig, jwt: string): SupabaseClient {
  return createClient(config.supabaseUrl, config.anonKey, {
    ...options,
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

export function serviceClient(config: ServerConfig): SupabaseClient {
  if (!config.serviceRoleKey) throw new HttpError(500, "server_configuration_error");
  return createClient(config.supabaseUrl, config.serviceRoleKey, options);
}

/** Verifies the JWT with Supabase Auth and returns the user id. */
export async function requireUser(config: ServerConfig, jwt: string | null): Promise<string> {
  if (!jwt) throw new HttpError(401, "not_authenticated");
  const client = createClient(config.supabaseUrl, config.anonKey, options);
  const { data, error } = await client.auth.getUser(jwt);
  if (error || !data.user) throw new HttpError(401, "not_authenticated");
  return data.user.id;
}

/** Platform-admin check uses the database's own rule (listed + aal2). */
export async function requirePlatformAdmin(client: SupabaseClient): Promise<void> {
  const { data, error } = await client.rpc("get_my_context");
  if (error) throw new HttpError(503, "context_unavailable");
  if (!(data as { is_platform_admin?: boolean } | null)?.is_platform_admin) {
    throw new HttpError(403, "platform_admin_required");
  }
}

export type { SupabaseClient };
