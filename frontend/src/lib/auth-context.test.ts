import { describe, expect, it } from "vitest";
import { parseAuthContext } from "./auth-context";

const userId = "e8f4e17c-2be1-4596-9a58-895e9dcc780a";
const tenantId = "d3fe40e2-93a4-4c1b-913d-9f4f415dc16f";

describe("parseAuthContext", () => {
  it("accepts the documented context response", () => {
    expect(
      parseAuthContext(
        {
          user_id: userId,
          is_platform_admin: false,
          platform_admin_mfa_required: false,
          memberships: [
            {
              tenant_id: tenantId,
              business_name: "Example Client",
              slug: "example-client",
              tenant_status: "active",
              role: "viewer",
            },
          ],
        },
        userId,
      ).memberships[0].role,
    ).toBe("viewer");
  });

  it("rejects a context response for a different authenticated user", () => {
    expect(() =>
      parseAuthContext(
        {
          user_id: userId,
          is_platform_admin: false,
          platform_admin_mfa_required: false,
          memberships: [],
        },
        tenantId,
      ),
    ).toThrow(/could not be verified/i);
  });

  it("rejects unknown tenant roles instead of trusting them", () => {
    expect(() =>
      parseAuthContext(
        {
          user_id: userId,
          is_platform_admin: false,
          platform_admin_mfa_required: false,
          memberships: [
            {
              tenant_id: tenantId,
              business_name: "Example Client",
              slug: "example-client",
              tenant_status: "active",
              role: "super_admin",
            },
          ],
        },
        userId,
      ),
    ).toThrow(/could not be verified/i);
  });
});
