import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MailPlus, UserX, Users } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Alert } from "../../components/ui/Alert";
import { StatusBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { ConfirmButton, Select } from "../../components/ui/Controls";
import { Field } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { EmptyState, QueryView, SectionCard } from "../../components/ui/States";
import { formatDate } from "../../lib/analytics";
import { queryKeys, useApi } from "../../lib/api/ApiProvider";
import { errorMessage } from "../../lib/api/errors";
import type { TenantRole } from "../../lib/auth-context";
import { emailSchema } from "../../lib/validation";

const ROLES: Array<{ value: TenantRole; label: string; description: string }> = [
  { value: "owner", label: "Owner", description: "Full workspace control, including owners and admins" },
  { value: "admin", label: "Admin", description: "Manages members, sees the activity log" },
  { value: "manager", label: "Manager", description: "Connects ad accounts and starts syncs" },
  { value: "viewer", label: "Viewer", description: "Reads dashboards, audits and reports" },
  { value: "client", label: "Client", description: "Same access as viewer" },
];

const inviteSchema = z.object({ email: emailSchema, role: z.enum(["owner", "admin", "manager", "viewer", "client"]) });
type InviteValues = z.infer<typeof inviteSchema>;

/**
 * actorRole: the signed-in user's authority in this tenant. Platform admins
 * may invite (database rule: invitations require an aal2 platform admin).
 */
export function TeamPanel({
  tenantId,
  actorRole,
  currentUserId,
}: {
  tenantId: string;
  actorRole: "platform_admin" | TenantRole;
  currentUserId: string | null;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const membersQuery = useQuery({ queryKey: queryKeys.members(tenantId), queryFn: () => api.listMembers(tenantId) });
  const invitationsQuery = useQuery({ queryKey: queryKeys.invitations(tenantId), queryFn: () => api.listInvitations(tenantId) });
  const canInvite = actorRole === "platform_admin";
  const isOwner = actorRole === "owner" || actorRole === "platform_admin";
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.members(tenantId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.invitations(tenantId) });
  };

  const form = useForm<InviteValues>({ resolver: zodResolver(inviteSchema), defaultValues: { email: "", role: "client" } });
  const invite = useMutation({
    mutationFn: (values: InviteValues) => api.inviteMember(tenantId, values.email.trim().toLowerCase(), values.role),
    onSuccess: () => {
      toast.success("Invitation sent");
      form.reset({ email: "", role: form.getValues("role") });
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: TenantRole }) => api.changeMemberRole(tenantId, userId, role),
    onSuccess: () => {
      toast.success("Role updated");
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const manageableRoles = (current: TenantRole) =>
    ROLES.filter((role) => isOwner || (role.value !== "owner" && role.value !== "admin") || role.value === current);

  return (
    <div className="space-y-5">
      {canInvite ? (
        <SectionCard title="Invite a member" description="An email with a secure, single-use link is sent through Supabase Auth. Links expire after 7 days.">
          <form className="grid gap-4 p-5 sm:grid-cols-[1fr_200px_auto] sm:items-end sm:p-6" onSubmit={form.handleSubmit((values) => invite.mutate(values))} noValidate>
            <Field label="Email address" htmlFor="invite-email" error={form.formState.errors.email?.message}>
              <Input id="invite-email" type="email" autoComplete="off" {...form.register("email")} aria-invalid={Boolean(form.formState.errors.email)} />
            </Field>
            <Field label="Role" htmlFor="invite-role">
              <Select id="invite-role" {...form.register("role")}>
                {ROLES.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
              </Select>
            </Field>
            <Button type="submit" loading={invite.isPending}><MailPlus aria-hidden="true" className="h-4 w-4" /> Send invite</Button>
          </form>
        </SectionCard>
      ) : (
        <Alert tone="info" title="Adding people">
          New members are invited by your PRISIM account team. Contact them with the person's email address and the role they need.
        </Alert>
      )}

      <SectionCard title="Members">
        <QueryView query={membersQuery} empty={<EmptyState icon={<Users />} title="No members yet" description={canInvite ? "Invite the client's first owner above." : undefined} />}>
          {(members) => (
            <ul className="divide-y divide-slate-100">
              {members.map((member) => {
                const self = member.user_id === currentUserId;
                const canEdit = member.status === "active" && !self && (isOwner || (member.role !== "owner" && member.role !== "admin"));
                return (
                  <li key={member.user_id} className="flex flex-wrap items-center gap-3 px-5 py-3 sm:px-6">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-600">
                      {(member.full_name ?? member.email ?? "?").slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink-950">{member.full_name ?? member.email}{self && <span className="text-slate-400"> (you)</span>}</p>
                      <p className="truncate text-xs text-slate-500">{member.email} · joined {formatDate(member.created_at)}</p>
                    </div>
                    {member.status !== "active" && <StatusBadge status={member.status} />}
                    <div className="w-36">
                      <label className="sr-only" htmlFor={`role-${member.user_id}`}>Role for {member.email}</label>
                      <Select
                        id={`role-${member.user_id}`}
                        value={member.role}
                        disabled={!canEdit || changeRole.isPending}
                        onChange={(event) => changeRole.mutate({ userId: member.user_id, role: event.target.value as TenantRole })}
                      >
                        {manageableRoles(member.role).map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
                      </Select>
                    </div>
                    <ConfirmButton
                      title="Remove access?"
                      description={`${member.email ?? "This member"} will lose access to this workspace immediately, and any pending invitations for them are revoked.`}
                      confirmLabel="Remove access"
                      variant="ghost"
                      disabled={!canEdit}
                      onConfirm={async () => {
                        try {
                          await api.deactivateMember(tenantId, member.user_id);
                          toast.success("Access removed");
                          refresh();
                        } catch (error) {
                          toast.error(errorMessage(error));
                        }
                      }}
                    >
                      <UserX aria-hidden="true" className="h-4 w-4" /><span className="sr-only">Remove access</span>
                    </ConfirmButton>
                  </li>
                );
              })}
            </ul>
          )}
        </QueryView>
      </SectionCard>

      <SectionCard title="Invitations">
        <QueryView query={invitationsQuery} empty={<EmptyState title="No invitations" description="Sent invitations and their status appear here." />}>
          {(invitations) => (
            <ul className="divide-y divide-slate-100">
              {invitations.map((invitation) => (
                <li key={invitation.id} className="flex flex-wrap items-center gap-3 px-5 py-3 sm:px-6">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink-950">{invitation.email}</p>
                    <p className="text-xs capitalize text-slate-500">{invitation.role} · sent {formatDate(invitation.created_at)} · expires {formatDate(invitation.expires_at)}</p>
                  </div>
                  <StatusBadge status={invitation.status} />
                  {invitation.status === "pending" && (
                    <ConfirmButton
                      title="Revoke invitation?"
                      description="The invitation link stops working immediately."
                      confirmLabel="Revoke"
                      variant="ghost"
                      onConfirm={async () => {
                        try {
                          await api.revokeInvitation(invitation.id);
                          toast.success("Invitation revoked");
                          refresh();
                        } catch (error) {
                          toast.error(errorMessage(error));
                        }
                      }}
                    >
                      Revoke
                    </ConfirmButton>
                  )}
                </li>
              ))}
            </ul>
          )}
        </QueryView>
      </SectionCard>
    </div>
  );
}
