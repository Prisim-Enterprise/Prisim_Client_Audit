import { useParams } from "react-router-dom";
import { useAuth } from "../../context/AuthProvider";
import type { TenantMembership, TenantRole } from "../../lib/auth-context";

const RANK: Record<TenantRole, number> = { owner: 50, admin: 40, manager: 30, viewer: 10, client: 10 };

export function roleAtLeast(role: TenantRole | undefined, minimum: TenantRole) {
  return role !== undefined && RANK[role] >= RANK[minimum];
}

/** The membership for /app/:tenantSlug (guaranteed by ClientAccessGate). */
export function useWorkspace(): TenantMembership & { base: string } {
  const { tenantSlug = "" } = useParams();
  const { memberships } = useAuth();
  const membership = memberships.find((item) => item.slug === tenantSlug);
  if (!membership) throw new Error("Workspace not available.");
  return { ...membership, base: `/app/${membership.slug}` };
}
