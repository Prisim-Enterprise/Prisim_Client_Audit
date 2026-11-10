import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const appUrlValue = Deno.env.get("APP_URL");
const roles = new Set(["owner", "admin", "manager", "viewer", "client"]);

function response(status: number, body: Record<string, unknown>, origin?: string) {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Headers", "authorization, apikey, content-type, x-client-info");
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function invitationToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function invitationTokenHash(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type AuthDeliveryError = { code?: string | null; status?: number | null; message?: string };

function isExistingAccountError(error: AuthDeliveryError) {
  return error.code === "email_exists"
    || (error.status === 422 && /already (registered|exists)/i.test(error.message ?? ""));
}

Deno.serve(async (request) => {
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !appUrlValue) {
    return response(500, { error: "server_configuration_error" });
  }

  let appUrl: URL;
  try {
    appUrl = new URL(appUrlValue);
  } catch {
    return response(500, { error: "server_configuration_error" });
  }
  const isLocal = ["localhost", "127.0.0.1"].includes(appUrl.hostname);
  if (appUrl.protocol !== "https:" && !(isLocal && appUrl.protocol === "http:")) {
    return response(500, { error: "server_configuration_error" });
  }
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") {
    if (origin !== appUrl.origin) return response(403, { error: "origin_not_allowed" });
    return response(200, {}, appUrl.origin);
  }
  if (request.method !== "POST") {
    return response(405, { error: "method_not_allowed" }, appUrl.origin);
  }
  if (origin && origin !== appUrl.origin) {
    return response(403, { error: "origin_not_allowed" });
  }

  const authorization = request.headers.get("Authorization");
  const tokenMatch = authorization?.match(/^Bearer\s+(\S+)$/i);
  if (!tokenMatch) return response(401, { error: "not_authenticated" }, appUrl.origin);

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return response(400, { error: "invalid_request" }, appUrl.origin);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return response(400, { error: "invalid_request" }, appUrl.origin);
  }
  const input = payload as { tenantId?: unknown; email?: unknown; role?: unknown };
  if (
    typeof input.tenantId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.tenantId)
    || typeof input.email !== "string"
    || input.email.length > 254
    || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email.trim())
    || typeof input.role !== "string"
    || !roles.has(input.role)
  ) {
    return response(400, { error: "invalid_request" }, appUrl.origin);
  }
  const email = input.email.trim().toLowerCase();

  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser(tokenMatch[1]);
  if (userError || !userData.user) {
    return response(401, { error: "not_authenticated" }, appUrl.origin);
  }

  const authorizedUserClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: actionResult, error: actionError } = await authorizedUserClient.rpc(
    "begin_privileged_action",
    { p_tenant_id: input.tenantId, p_action: "invitation.create" },
  );
  const action = Array.isArray(actionResult) ? actionResult[0] : null;
  if (actionError || !action || typeof action.action_id !== "string") {
    return response(403, { error: "not_authorized" }, appUrl.origin);
  }

  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const rawToken = invitationToken();
  const tokenHash = await invitationTokenHash(rawToken);
  const { data: invitationResult, error: invitationError } = await serviceClient.rpc(
    "create_invitation",
    {
      p_action_id: action.action_id,
      p_tenant_id: input.tenantId,
      p_email: email,
      p_role: input.role,
      p_token_hash: tokenHash,
    },
  );
  const invitation = Array.isArray(invitationResult) ? invitationResult[0] : null;
  if (
    invitationError
    || !invitation
    || typeof invitation.invitation_id !== "string"
    || typeof invitation.invitation_expires_at !== "string"
  ) {
    return response(400, { error: "invitation_not_created" }, appUrl.origin);
  }

  const redirectUrl = new URL("/accept-invite", appUrl);
  redirectUrl.searchParams.set("token", rawToken);
  let deliveryError: AuthDeliveryError | null = null;
  try {
    const inviteResult = await serviceClient.auth.admin.inviteUserByEmail(
      email,
      { redirectTo: redirectUrl.toString() },
    );
    deliveryError = inviteResult.error;
    if (deliveryError && isExistingAccountError(deliveryError)) {
      const mailClient = createClient(supabaseUrl, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const otpResult = await mailClient.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: redirectUrl.toString(),
          shouldCreateUser: false,
        },
      });
      deliveryError = otpResult.error;
    }
  } catch {
    deliveryError = { message: "Auth email delivery failed" };
  }

  if (deliveryError) {
    try {
      const { error: cancellationError } = await serviceClient.rpc(
        "fail_invitation_delivery",
        { p_action_id: action.action_id, p_invitation_id: invitation.invitation_id },
      );
      if (cancellationError) {
        return response(500, { error: "invitation_delivery_cleanup_failed" }, appUrl.origin);
      }
    } catch {
      return response(500, { error: "invitation_delivery_cleanup_failed" }, appUrl.origin);
    }
    return response(502, { error: "invitation_email_not_sent" }, appUrl.origin);
  }

  return response(200, {
    invitation_id: invitation.invitation_id,
    invitation_expires_at: invitation.invitation_expires_at,
  }, appUrl.origin);
});
