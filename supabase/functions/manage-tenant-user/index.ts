import { bearerToken, withHttp } from "../_shared/http.ts";
import { readServerConfig, serviceClient, userClient } from "../_shared/supabase.ts";
import { type ClientUserRole, createManageTenantUserHandler, type ManageTenantUserDependencies } from "./handler.ts";

function dependencies(appUrl: string): ManageTenantUserDependencies {
  const config = readServerConfig(true);
  const service = serviceClient(config);
  const asCaller = (jwt: string) => userClient(config, jwt);

  return {
    appUrl,
    async authenticate(jwt) {
      const { data, error } = await service.auth.getUser(jwt);
      return error || !data.user ? null : data.user.id;
    },
    async isPlatformAdmin(jwt) {
      const { data, error } = await asCaller(jwt).rpc("get_my_context");
      return !error && (data as { is_platform_admin?: boolean } | null)?.is_platform_admin === true;
    },
    async getTenant(jwt, tenantId) {
      const { data, error } = await asCaller(jwt).from("tenants").select("id, status").eq("id", tenantId).maybeSingle();
      return error || !data ? null : data;
    },
    async findUserIdByEmail(jwt, email) {
      // Auth stores e-mail addresses in lower case; profiles mirrors auth.users.
      const { data, error } = await asCaller(jwt).from("profiles").select("id").eq("email", email).limit(1).maybeSingle();
      return error || !data ? null : data.id;
    },
    async createAuthUser(email, fullName) {
      const { data, error } = await service.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: fullName ? { full_name: fullName } : {},
      });
      if (error) {
        const code = (error as { code?: string }).code;
        return code === "email_exists" || code === "user_already_exists" || error.status === 422 ? "exists" : null;
      }
      return data.user ? { id: data.user.id } : null;
    },
    async deleteAuthUser(userId) {
      await service.auth.admin.deleteUser(userId);
    },
    async getMembership(jwt, tenantId, userId) {
      const { data, error } = await asCaller(jwt)
        .from("tenant_memberships")
        .select("role, status")
        .eq("tenant_id", tenantId)
        .eq("user_id", userId)
        .maybeSingle();
      return error || !data ? null : data;
    },
    async insertMembership(jwt, tenantId, userId, role: ClientUserRole) {
      const { error } = await asCaller(jwt)
        .from("tenant_memberships")
        .insert({ tenant_id: tenantId, user_id: userId, role, status: "active" });
      return !error;
    },
    async reactivateMembership(jwt, tenantId, userId, role: ClientUserRole) {
      const { error } = await asCaller(jwt)
        .from("tenant_memberships")
        .update({ role, status: "active" })
        .eq("tenant_id", tenantId)
        .eq("user_id", userId);
      return !error;
    },
    async getUserEmail(jwt, userId) {
      const { data, error } = await asCaller(jwt).from("profiles").select("email").eq("id", userId).maybeSingle();
      return error || !data?.email ? null : data.email;
    },
    async isStaffAccount(jwt, userId) {
      const { data, error } = await asCaller(jwt).from("platform_admins").select("user_id").eq("user_id", userId).maybeSingle();
      // Fail closed: if the lookup fails, treat the account as staff.
      return error ? true : Boolean(data);
    },
    async generateRecoveryToken(email) {
      const { data, error } = await service.auth.admin.generateLink({ type: "recovery", email });
      return error ? null : data.properties?.hashed_token ?? null;
    },
    log: (message) => console.warn(`[manage-tenant-user] ${message}`),
  };
}

if (import.meta.main) {
  const appUrl = Deno.env.get("APP_URL");
  let handler: ReturnType<typeof createManageTenantUserHandler> | undefined;
  Deno.serve(withHttp(appUrl, (request, origin) => {
    handler ??= createManageTenantUserHandler(dependencies(new URL(origin).origin));
    return handler(request, origin, bearerToken(request));
  }, console.warn));
}
