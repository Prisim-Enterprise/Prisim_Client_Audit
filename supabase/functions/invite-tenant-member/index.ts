import { createClient } from "npm:@supabase/supabase-js@2";

type Configuration = {
  supabaseUrl?: string;
  anonKey?: string;
  serviceRoleKey?: string;
  appUrl?: string;
};

type Invitation = {
  id: string;
  expiresAt: string;
};

export type InvitationDependencies = {
  authenticate(token: string): Promise<boolean>;
  beginAction(authorization: string, tenantId: string): Promise<string | null>;
  createInvitation(
    actionId: string,
    tenantId: string,
    email: string,
    role: string,
    tokenHash: string,
  ): Promise<Invitation | null>;
  sendInvitation(email: string, redirectUrl: string): Promise<boolean>;
  failInvitation(actionId: string, invitationId: string): Promise<boolean>;
};

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

export function createInviteHandler(
  config: Configuration,
  dependencies: InvitationDependencies,
) {
  return async (request: Request): Promise<Response> => {
    const { supabaseUrl, anonKey, serviceRoleKey, appUrl: appUrlValue } = config;
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
    const accessToken = tokenMatch[1];
    if (!(await dependencies.authenticate(accessToken))) {
      return response(401, { error: "not_authenticated" }, appUrl.origin);
    }

    const actionId = await dependencies.beginAction(
      `Bearer ${accessToken}`,
      input.tenantId,
    );
    if (!actionId) return response(403, { error: "not_authorized" }, appUrl.origin);

    const rawToken = invitationToken();
    const tokenHash = await invitationTokenHash(rawToken);
    const invitation = await dependencies.createInvitation(
      actionId,
      input.tenantId,
      email,
      input.role,
      tokenHash,
    );
    if (!invitation) return response(400, { error: "invitation_not_created" }, appUrl.origin);

    const redirectUrl = new URL("/accept-invite", appUrl);
    redirectUrl.searchParams.set("token", rawToken);
    let delivered = false;
    try {
      delivered = await dependencies.sendInvitation(email, redirectUrl.toString());
    } catch {
      delivered = false;
    }

    if (!delivered) {
      let cleanupSucceeded = false;
      try {
        cleanupSucceeded = await dependencies.failInvitation(actionId, invitation.id);
      } catch {
        cleanupSucceeded = false;
      }
      if (!cleanupSucceeded) {
        return response(500, { error: "invitation_delivery_cleanup_failed" }, appUrl.origin);
      }
      return response(502, { error: "invitation_email_not_sent" }, appUrl.origin);
    }

    return response(200, {
      invitation_id: invitation.id,
      invitation_expires_at: invitation.expiresAt,
    }, appUrl.origin);
  };
}

function createSupabaseDependencies(config: Required<Configuration>): InvitationDependencies {
  const userClient = createClient(config.supabaseUrl, config.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const serviceClient = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return {
    async authenticate(token) {
      const { data, error } = await userClient.auth.getUser(token);
      return !error && Boolean(data.user);
    },
    async beginAction(authorization, tenantId) {
      const authorizedClient = createClient(config.supabaseUrl, config.anonKey, {
        global: { headers: { Authorization: authorization } },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data, error } = await authorizedClient.rpc("begin_privileged_action", {
        p_tenant_id: tenantId,
        p_action: "invitation.create",
      });
      const action = Array.isArray(data) ? data[0] : null;
      return !error && typeof action?.action_id === "string" ? action.action_id : null;
    },
    async createInvitation(actionId, tenantId, email, role, tokenHash) {
      const { data, error } = await serviceClient.rpc("create_invitation", {
        p_action_id: actionId,
        p_tenant_id: tenantId,
        p_email: email,
        p_role: role,
        p_token_hash: tokenHash,
      });
      const invitation = Array.isArray(data) ? data[0] : null;
      if (
        error
        || typeof invitation?.invitation_id !== "string"
        || typeof invitation.invitation_expires_at !== "string"
      ) {
        return null;
      }
      return {
        id: invitation.invitation_id,
        expiresAt: invitation.invitation_expires_at,
      };
    },
    async sendInvitation(email, redirectUrl) {
      const inviteResult = await serviceClient.auth.admin.inviteUserByEmail(
        email,
        { redirectTo: redirectUrl },
      );
      if (!inviteResult.error) return true;
      if (!isExistingAccountError(inviteResult.error)) return false;

      const mailClient = createClient(config.supabaseUrl, config.anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const otpResult = await mailClient.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: redirectUrl,
          shouldCreateUser: false,
        },
      });
      return !otpResult.error;
    },
    async failInvitation(actionId, invitationId) {
      const { error } = await serviceClient.rpc("fail_invitation_delivery", {
        p_action_id: actionId,
        p_invitation_id: invitationId,
      });
      return !error;
    },
  };
}

if (import.meta.main) {
  const config: Configuration = {
    supabaseUrl: Deno.env.get("SUPABASE_URL"),
    anonKey: Deno.env.get("SUPABASE_ANON_KEY"),
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    appUrl: Deno.env.get("APP_URL"),
  };
  const dependencies = config.supabaseUrl && config.anonKey && config.serviceRoleKey && config.appUrl
    ? createSupabaseDependencies({
      supabaseUrl: config.supabaseUrl,
      anonKey: config.anonKey,
      serviceRoleKey: config.serviceRoleKey,
      appUrl: config.appUrl,
    })
    : {
      authenticate: async () => false,
      beginAction: async () => null,
      createInvitation: async () => null,
      sendInvitation: async () => false,
      failInvitation: async () => false,
    };
  Deno.serve(createInviteHandler(config, dependencies));
}
