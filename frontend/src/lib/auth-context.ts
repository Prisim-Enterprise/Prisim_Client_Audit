import { z } from "zod";

const tenantRoleSchema = z.enum(["owner", "admin", "manager", "viewer", "client"]);

export const authContextSchema = z.object({
  user_id: z.string().uuid(),
  is_platform_admin: z.boolean(),
  platform_admin_mfa_required: z.boolean(),
  memberships: z.array(
    z.object({
      tenant_id: z.string().uuid(),
      business_name: z.string(),
      slug: z.string(),
      tenant_status: z.enum(["active", "inactive", "suspended"]),
      role: tenantRoleSchema,
    }),
  ),
});

export type TenantRole = z.infer<typeof tenantRoleSchema>;
export type TenantMembership = z.infer<typeof authContextSchema>["memberships"][number];
export type AuthContextData = z.infer<typeof authContextSchema>;

export type UserProfile = {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
};

export function parseAuthContext(value: unknown, authenticatedUserId: string): AuthContextData {
  const result = authContextSchema.safeParse(value);
  if (!result.success || result.data.user_id !== authenticatedUserId) {
    throw new Error(
      "Your access details could not be verified. Confirm that the Supabase security migration is applied, then try again.",
    );
  }
  return result.data;
}
