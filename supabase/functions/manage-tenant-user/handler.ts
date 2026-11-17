// manage-tenant-user: PRISIM staff provision client user accounts.
//
//   create         -> creates the Auth user for an email (or reuses the
//                     existing account) and gives it an active membership
//                     in the tenant with the chosen role
//   password-link  -> single-use, time-limited link with which a member sets
//                     (first login) or resets their own password
//
// Only aal2 platform admins may call it: the check uses the database's own
// rule (get_my_context) with the caller's JWT. Membership reads and writes
// also use the caller's JWT, so RLS and the audit trigger apply and the audit
// log names the staff member. The service_role key is used only for the Auth
// admin API (create user, generate link) and never leaves this function.
// No password is ever generated, stored or returned.

import { HttpError, isUuid, json, readBody } from "../_shared/http.ts";

export const CLIENT_USER_ROLES = ["owner", "viewer"] as const;
export type ClientUserRole = (typeof CLIENT_USER_ROLES)[number];

export type MembershipRow = { role: string; status: string };

export type ManageTenantUserDependencies = {
  /** Verifies the JWT with Supabase Auth; returns the user id or null. */
  authenticate(jwt: string): Promise<string | null>;
  /** get_my_context().is_platform_admin evaluated with the caller's JWT (listed + aal2). */
  isPlatformAdmin(jwt: string): Promise<boolean>;
  getTenant(jwt: string, tenantId: string): Promise<{ id: string; status: string } | null>;
  findUserIdByEmail(jwt: string, email: string): Promise<string | null>;
  /** Auth admin API. "exists" when an account with this email already exists. */
  createAuthUser(email: string, fullName: string | null): Promise<{ id: string } | "exists" | null>;
  deleteAuthUser(userId: string): Promise<void>;
  getMembership(jwt: string, tenantId: string, userId: string): Promise<MembershipRow | null>;
  insertMembership(jwt: string, tenantId: string, userId: string, role: ClientUserRole): Promise<boolean>;
  reactivateMembership(jwt: string, tenantId: string, userId: string, role: ClientUserRole): Promise<boolean>;
  getUserEmail(jwt: string, userId: string): Promise<string | null>;
  /** True when the account is a PRISIM staff account (listed in platform_admins). */
  isStaffAccount(jwt: string, userId: string): Promise<boolean>;
  /** Auth admin generateLink(type "recovery"); returns the hashed token only. */
  generateRecoveryToken(email: string): Promise<string | null>;
  appUrl: string;
  log(message: string): void;
};

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function role(value: unknown): ClientUserRole {
  if (typeof value === "string" && (CLIENT_USER_ROLES as readonly string[]).includes(value)) return value as ClientUserRole;
  throw new HttpError(400, "invalid_request");
}

function email(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_request");
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) throw new HttpError(400, "invalid_request");
  return normalized;
}

function fullName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 120) throw new HttpError(400, "invalid_request");
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function passwordLink(appUrl: string, tokenHash: string): string {
  const url = new URL("/reset-password", appUrl);
  url.searchParams.set("token_hash", tokenHash);
  url.searchParams.set("type", "recovery");
  return url.toString();
}

export function createManageTenantUserHandler(deps: ManageTenantUserDependencies) {
  return async (request: Request, origin: string, jwt: string | null): Promise<Response> => {
    if (!jwt) throw new HttpError(401, "not_authenticated");
    const callerId = await deps.authenticate(jwt);
    if (!callerId) throw new HttpError(401, "not_authenticated");
    if (!(await deps.isPlatformAdmin(jwt))) throw new HttpError(403, "platform_admin_required");

    const body = await readBody(request);
    if (!isUuid(body.tenantId)) throw new HttpError(400, "invalid_request");
    const tenantId = body.tenantId;

    if (body.action === "create") {
      const address = email(body.email);
      const name = fullName(body.fullName);
      const memberRole = role(body.role);

      const tenant = await deps.getTenant(jwt, tenantId);
      if (!tenant) throw new HttpError(404, "tenant_not_found");
      if (tenant.status !== "active") throw new HttpError(409, "tenant_not_active");

      let userId = await deps.findUserIdByEmail(jwt, address);
      let accountCreated = false;
      if (!userId) {
        const created = await deps.createAuthUser(address, name);
        if (created === "exists") {
          userId = await deps.findUserIdByEmail(jwt, address);
          if (!userId) throw new HttpError(409, "account_conflict");
        } else if (!created) {
          throw new HttpError(502, "account_not_created");
        } else {
          userId = created.id;
          accountCreated = true;
        }
      }

      // Staff accounts are never client members: a password link for a member
      // must never be usable against a PRISIM administrator account.
      if (!accountCreated && (await deps.isStaffAccount(jwt, userId))) throw new HttpError(409, "staff_account");

      const existing = await deps.getMembership(jwt, tenantId, userId);
      if (existing?.status === "active") throw new HttpError(409, "already_member");
      const saved = existing
        ? await deps.reactivateMembership(jwt, tenantId, userId, memberRole)
        : await deps.insertMembership(jwt, tenantId, userId, memberRole);
      if (!saved) {
        if (accountCreated) {
          // Do not leave an account without access behind.
          try {
            await deps.deleteAuthUser(userId);
          } catch {
            deps.log("cleanup of new account failed");
          }
        }
        throw new HttpError(500, "membership_not_saved");
      }
      return json(200, { userId, accountCreated, membership: existing ? "reactivated" : "created" }, origin);
    }

    if (body.action === "password-link") {
      if (!isUuid(body.userId)) throw new HttpError(400, "invalid_request");
      const membership = await deps.getMembership(jwt, tenantId, body.userId);
      if (!membership || membership.status !== "active") throw new HttpError(404, "member_not_found");
      if (await deps.isStaffAccount(jwt, body.userId)) throw new HttpError(409, "staff_account");
      const address = await deps.getUserEmail(jwt, body.userId);
      if (!address) throw new HttpError(404, "member_not_found");
      const tokenHash = await deps.generateRecoveryToken(address);
      if (!tokenHash) throw new HttpError(502, "link_not_generated");
      return json(200, { url: passwordLink(deps.appUrl, tokenHash) }, origin);
    }

    throw new HttpError(400, "invalid_request");
  };
}
