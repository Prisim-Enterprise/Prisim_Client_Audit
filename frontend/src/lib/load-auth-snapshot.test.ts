import { describe, expect, it } from "vitest";
import { loadAuthSnapshot } from "./load-auth-snapshot";

const userId = "e8f4e17c-2be1-4596-9a58-895e9dcc780a";
const otherUserId = "8f00ea9a-fb92-423f-90e2-7ac125863d4a";
const tenantA = "d3fe40e2-93a4-4c1b-913d-9f4f415dc16f";
const tenantB = "d807e3c9-840a-4f5c-bb39-9a7051c22c35";

const profile = {
  id: userId,
  full_name: "Client User",
  avatar_url: null,
};

function makeContext(memberships: Array<{
  tenant_id: string;
  business_name: string;
  slug: string;
  tenant_status: "active" | "inactive" | "suspended";
  role: "owner" | "admin" | "manager" | "viewer" | "client";
}>) {
  return {
    user_id: userId,
    is_platform_admin: false,
    platform_admin_mfa_required: false,
    memberships,
  };
}

describe("loadAuthSnapshot", () => {
  it("loads the authenticated user's RPC context and RLS-protected profile", async () => {
    const snapshot = await loadAuthSnapshot(
      userId,
      async () => ({
        data: makeContext([{
          tenant_id: tenantA,
          business_name: "Tenant A",
          slug: "tenant-a",
          tenant_status: "active",
          role: "client",
        }]),
        error: null,
      }),
      async () => ({ data: profile, error: null }),
    );

    expect(snapshot.context.user_id).toBe(userId);
    expect(snapshot.context.memberships.map((membership) => membership.tenant_id)).toEqual([tenantA]);
    expect(snapshot.profile).toEqual(profile);
  });

  it("reports the exact missing-context RPC condition instead of disguising it", async () => {
    await expect(loadAuthSnapshot(
      userId,
      async () => ({ data: null, error: { code: "PGRST202" } }),
      async () => ({ data: profile, error: null }),
    )).rejects.toThrow(/public\.get_my_context\(\).*missing.*PGRST202/i);
  });

  it("reports profile-query failures separately from context-RPC failures", async () => {
    await expect(loadAuthSnapshot(
      userId,
      async () => ({ data: makeContext([]), error: null }),
      async () => ({ data: null, error: { code: "42501" } }),
    )).rejects.toThrow(/profile query failed \(42501\)/i);
  });

  it("rejects context belonging to a different authenticated user", async () => {
    await expect(loadAuthSnapshot(
      otherUserId,
      async () => ({ data: makeContext([]), error: null }),
      async () => ({ data: profile, error: null }),
    )).rejects.toThrow(/could not be verified/i);
  });

  it("accepts only the tenant memberships returned for the authenticated caller", async () => {
    const snapshot = await loadAuthSnapshot(
      userId,
      async () => ({
        data: makeContext([
          {
            tenant_id: tenantA,
            business_name: "Tenant A",
            slug: "tenant-a",
            tenant_status: "active",
            role: "client",
          },
          {
            tenant_id: tenantB,
            business_name: "Tenant B",
            slug: "tenant-b",
            tenant_status: "active",
            role: "viewer",
          },
        ]),
        error: null,
      }),
      async () => ({ data: profile, error: null }),
    );

    expect(snapshot.context.memberships.map((membership) => membership.tenant_id)).toEqual([
      tenantA,
      tenantB,
    ]);
  });
});
