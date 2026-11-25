// @vitest-environment node
import { withHttp } from "@functions/_shared/http.ts";
import {
  createManageTenantUserHandler,
  type ManageTenantUserDependencies,
  passwordLink,
} from "@functions/manage-tenant-user/handler.ts";
import { describe, expect, it, vi } from "vitest";

const ORIGIN = "https://portal.example.com";
const STAFF = "e1000000-0000-4000-8000-000000000001";
const CLIENT_USER = "e1000000-0000-4000-8000-000000000002";
const TENANT = "d1000000-0000-4000-8000-000000000001";
const TOKEN_HASH = "pkce_" + "a".repeat(56);

function deps(overrides: Partial<ManageTenantUserDependencies> = {}): ManageTenantUserDependencies {
  return {
    appUrl: ORIGIN,
    authenticate: vi.fn(async () => STAFF),
    isPlatformAdmin: vi.fn(async () => true),
    getTenant: vi.fn(async () => ({ id: TENANT, status: "active" })),
    findUserIdByEmail: vi.fn(async () => null),
    createAuthUser: vi.fn(async () => ({ id: CLIENT_USER })),
    deleteAuthUser: vi.fn(async () => undefined),
    getMembership: vi.fn(async () => null),
    insertMembership: vi.fn(async () => true),
    reactivateMembership: vi.fn(async () => true),
    getUserEmail: vi.fn(async () => "owner@client.example"),
    isStaffAccount: vi.fn(async () => false),
    generateRecoveryToken: vi.fn(async () => TOKEN_HASH),
    log: vi.fn(),
    ...overrides,
  };
}

function call(d: ManageTenantUserDependencies, body: unknown, jwt: string | null = "staff-jwt", origin = ORIGIN) {
  const handler = createManageTenantUserHandler(d);
  const http = withHttp(ORIGIN, (request, allowed) => handler(request, allowed, jwt));
  return http(new Request(`${ORIGIN}/fn`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

const create = { action: "create", tenantId: TENANT, email: " Owner@Client.Example ", fullName: " Rohan Rao ", role: "owner" };

describe("manage-tenant-user authorization", () => {
  it("rejects a request without a JWT before reading the body", async () => {
    const d = deps();
    const response = await call(d, "{not json", null);
    expect(response.status).toBe(401);
    expect(d.authenticate).not.toHaveBeenCalled();
  });

  it("rejects an invalid JWT", async () => {
    const d = deps({ authenticate: vi.fn(async () => null) });
    expect((await call(d, create)).status).toBe(401);
    expect(d.createAuthUser).not.toHaveBeenCalled();
  });

  it("rejects users who are not aal2 platform admins (clients, or staff without MFA)", async () => {
    const d = deps({ isPlatformAdmin: vi.fn(async () => false) });
    const response = await call(d, create);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "platform_admin_required" });
    expect(d.createAuthUser).not.toHaveBeenCalled();
    expect(d.generateRecoveryToken).not.toHaveBeenCalled();
  });

  it("rejects foreign browser origins", async () => {
    const d = deps();
    expect((await call(d, create, "staff-jwt", "https://evil.example")).status).toBe(403);
    expect(d.authenticate).not.toHaveBeenCalled();
  });
});

describe("manage-tenant-user create", () => {
  it("creates a confirmed account without a password and an active membership", async () => {
    const d = deps();
    const response = await call(d, create);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: CLIENT_USER, accountCreated: true, membership: "created" });
    expect(d.createAuthUser).toHaveBeenCalledWith("owner@client.example", "Rohan Rao");
    expect(d.insertMembership).toHaveBeenCalledWith("staff-jwt", TENANT, CLIENT_USER, "owner");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reuses an existing client account and reactivates a removed membership", async () => {
    const d = deps({
      findUserIdByEmail: vi.fn(async () => CLIENT_USER),
      getMembership: vi.fn(async () => ({ role: "viewer", status: "inactive" })),
    });
    const response = await call(d, { ...create, role: "viewer" });
    expect(await response.json()).toEqual({ userId: CLIENT_USER, accountCreated: false, membership: "reactivated" });
    expect(d.createAuthUser).not.toHaveBeenCalled();
    expect(d.reactivateMembership).toHaveBeenCalledWith("staff-jwt", TENANT, CLIENT_USER, "viewer");
  });

  it("refuses to add an existing active member again", async () => {
    const d = deps({ findUserIdByEmail: vi.fn(async () => CLIENT_USER), getMembership: vi.fn(async () => ({ role: "owner", status: "active" })) });
    expect((await call(d, create)).status).toBe(409);
    expect(d.insertMembership).not.toHaveBeenCalled();
  });

  it("never attaches a PRISIM staff account to a client", async () => {
    const d = deps({ findUserIdByEmail: vi.fn(async () => STAFF), isStaffAccount: vi.fn(async () => true) });
    const response = await call(d, create);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "staff_account" });
    expect(d.insertMembership).not.toHaveBeenCalled();
  });

  it("deletes a newly created account when the membership cannot be saved", async () => {
    const d = deps({ insertMembership: vi.fn(async () => false) });
    expect((await call(d, create)).status).toBe(500);
    expect(d.deleteAuthUser).toHaveBeenCalledWith(CLIENT_USER);
  });

  it("does not delete a pre-existing account when the membership cannot be saved", async () => {
    const d = deps({ findUserIdByEmail: vi.fn(async () => CLIENT_USER), insertMembership: vi.fn(async () => false) });
    expect((await call(d, create)).status).toBe(500);
    expect(d.deleteAuthUser).not.toHaveBeenCalled();
  });

  it("rejects suspended or unknown tenants", async () => {
    expect((await call(deps({ getTenant: vi.fn(async () => ({ id: TENANT, status: "suspended" })) }), create)).status).toBe(409);
    expect((await call(deps({ getTenant: vi.fn(async () => null) }), create)).status).toBe(404);
  });

  it.each([
    [{ ...create, email: "not-an-email" }],
    [{ ...create, role: "admin" }],
    [{ ...create, role: "platform_admin" }],
    [{ ...create, tenantId: "not-a-uuid" }],
    [{ ...create, fullName: "x".repeat(121) }],
    [{ ...create, action: "invite" }],
  ])("rejects invalid input %#", async (body) => {
    const d = deps();
    expect((await call(d, body)).status).toBe(400);
    expect(d.createAuthUser).not.toHaveBeenCalled();
  });
});

describe("manage-tenant-user password-link", () => {
  const linkBody = { action: "password-link", tenantId: TENANT, userId: CLIENT_USER };

  it("returns a single-use recovery link on the application origin", async () => {
    const d = deps({ getMembership: vi.fn(async () => ({ role: "owner", status: "active" })) });
    const response = await call(d, linkBody);
    expect(response.status).toBe(200);
    const { url } = await response.json();
    expect(url).toBe(`${ORIGIN}/reset-password?token_hash=${TOKEN_HASH}&type=recovery`);
    expect(d.generateRecoveryToken).toHaveBeenCalledWith("owner@client.example");
  });

  it("only issues links for active members of the given tenant", async () => {
    const d = deps({ getMembership: vi.fn(async () => null) });
    expect((await call(d, linkBody)).status).toBe(404);
    const inactive = deps({ getMembership: vi.fn(async () => ({ role: "viewer", status: "inactive" })) });
    expect((await call(inactive, linkBody)).status).toBe(404);
    expect(d.generateRecoveryToken).not.toHaveBeenCalled();
    expect(inactive.generateRecoveryToken).not.toHaveBeenCalled();
  });

  it("never issues a link for a PRISIM staff account", async () => {
    const d = deps({ getMembership: vi.fn(async () => ({ role: "owner", status: "active" })), isStaffAccount: vi.fn(async () => true) });
    expect((await call(d, linkBody)).status).toBe(409);
    expect(d.generateRecoveryToken).not.toHaveBeenCalled();
  });

  it("reports a generic error when Auth cannot generate the link", async () => {
    const d = deps({ getMembership: vi.fn(async () => ({ role: "owner", status: "active" })), generateRecoveryToken: vi.fn(async () => null) });
    const response = await call(d, linkBody);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "link_not_generated" });
  });

  it("builds links with an encoded token", () => {
    expect(passwordLink("https://app.example.com/", "a&b")).toBe("https://app.example.com/reset-password?token_hash=a%26b&type=recovery");
  });
});
