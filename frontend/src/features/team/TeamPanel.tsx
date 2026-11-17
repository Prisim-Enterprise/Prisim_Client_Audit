import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, UserPlus, UserRoundCheck, UserX, Users } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";
import { Alert } from "../../components/ui/Alert";
import { StatusBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { ConfirmButton, Select } from "../../components/ui/Controls";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/Dialog";
import { Field } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { EmptyState, QueryView, SectionCard } from "../../components/ui/States";
import { formatDate } from "../../lib/analytics";
import { queryKeys, useApi } from "../../lib/api/ApiProvider";
import { errorMessage } from "../../lib/api/errors";
import type { ClientUserRole, Member } from "../../lib/api/types";
import type { TenantRole } from "../../lib/auth-context";
import { emailSchema } from "../../lib/validation";

const ROLES: Array<{ value: ClientUserRole; label: string }> = [
  { value: "owner", label: "Owner" },
  { value: "viewer", label: "Viewer" },
];
const LEGACY_ROLE_LABELS: Record<TenantRole, string> = { owner: "Owner", admin: "Admin", manager: "Manager", viewer: "Viewer", client: "Client" };

const userSchema = z.object({
  fullName: z.string().trim().max(120, "Use at most 120 characters."),
  email: emailSchema,
  role: z.enum(["owner", "viewer"]),
});
type UserValues = z.infer<typeof userSchema>;

type IssuedLink = { email: string; url: string };

/**
 * Client user management for PRISIM staff (client detail → Users tab).
 * Staff create accounts, assign roles, issue password links and remove
 * access. Clients have no access to any of this: the Edge Function and the
 * database both require an aal2 platform admin.
 */
export function ClientUsersPanel({ tenantId, tenantActive }: { tenantId: string; tenantActive: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const membersQuery = useQuery({ queryKey: queryKeys.members(tenantId), queryFn: () => api.listMembers(tenantId) });
  const [issued, setIssued] = useState<IssuedLink | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.members(tenantId) });

  const form = useForm<UserValues>({ resolver: zodResolver(userSchema), defaultValues: { fullName: "", email: "", role: "owner" } });
  const errors = form.formState.errors;

  const issueLink = useMutation({
    mutationFn: ({ userId }: { userId: string; email: string }) => api.issuePasswordLink(tenantId, userId),
    onSuccess: ({ url }, { email }) => setIssued({ email, url }),
    onError: (error) => toast.error(errorMessage(error)),
  });

  const create = useMutation({
    mutationFn: (values: UserValues) =>
      api.createTenantUser({ tenantId, email: values.email.trim().toLowerCase(), fullName: values.fullName.trim() || undefined, role: values.role }),
    onSuccess: (result, values) => {
      const email = values.email.trim().toLowerCase();
      form.reset({ fullName: "", email: "", role: values.role });
      refresh();
      if (result.accountCreated) {
        toast.success("Account created");
        issueLink.mutate({ userId: result.userId, email });
      } else {
        toast.success(result.membership === "reactivated" ? "Access restored" : "Access granted to an existing account");
      }
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: ClientUserRole }) => api.changeMemberRole(tenantId, userId, role),
    onSuccess: () => {
      toast.success("Role updated");
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const restore = useMutation({
    mutationFn: (member: Member) =>
      api.createTenantUser({ tenantId, email: member.email ?? "", role: member.role === "owner" ? "owner" : "viewer" }),
    onSuccess: () => {
      toast.success("Access restored");
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <div className="space-y-5">
      <SectionCard
        title="Add a client user"
        description={<>Creates the person&apos;s account and gives them access to this client only. They set their own password with a single-use link; no password is ever sent. Their details are handled under the <Link to="/privacy-policy" target="_blank" className="font-medium text-accent-700 hover:underline">Privacy Policy</Link>.</>}
      >
        {tenantActive ? (
          <form
            className="grid gap-4 p-5 sm:grid-cols-2 sm:p-6 lg:grid-cols-[1fr_1fr_160px_auto] lg:items-start"
            onSubmit={form.handleSubmit((values) => create.mutate(values))}
            noValidate
          >
            <Field label="Full name" htmlFor="user-name" error={errors.fullName?.message} hint="Optional">
              <Input id="user-name" autoComplete="off" {...form.register("fullName")} aria-invalid={Boolean(errors.fullName)} aria-describedby={errors.fullName ? "user-name-error" : undefined} />
            </Field>
            <Field label="Email address" htmlFor="user-email" error={errors.email?.message}>
              <Input id="user-email" type="email" autoComplete="off" {...form.register("email")} aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? "user-email-error" : undefined} />
            </Field>
            <Field label="Role" htmlFor="user-role">
              <Select id="user-role" {...form.register("role")}>
                {ROLES.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
              </Select>
            </Field>
            <div className="lg:pt-7">
              <Button type="submit" loading={create.isPending || issueLink.isPending} className="w-full lg:w-auto">
                <UserPlus aria-hidden="true" className="h-4 w-4" /> Create user
              </Button>
            </div>
          </form>
        ) : (
          <div className="p-5 sm:p-6"><Alert tone="info">Reactivate this client before adding users.</Alert></div>
        )}
      </SectionCard>

      <SectionCard title="Users" description="Owners and viewers both see this client's dashboards, published audits and shared reports.">
        <QueryView query={membersQuery} empty={<EmptyState icon={<Users />} title="No users yet" description="Create the client's first owner above." />}>
          {(members) => (
            <ul className="divide-y divide-slate-100">
              {members.map((member) => {
                const active = member.status === "active";
                const label = member.full_name ?? member.email ?? "This user";
                return (
                  <li key={member.user_id} className="flex flex-wrap items-center gap-3 px-5 py-3 sm:px-6">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-600">
                      {label.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink-950">{label}</p>
                      <p className="truncate text-xs text-slate-500">{member.email} · added {formatDate(member.created_at)}</p>
                    </div>
                    {!active && <StatusBadge status={member.status} />}
                    <div className="w-32">
                      <label className="sr-only" htmlFor={`role-${member.user_id}`}>Role for {member.email}</label>
                      <Select
                        id={`role-${member.user_id}`}
                        value={member.role}
                        disabled={!active || changeRole.isPending}
                        onChange={(event) => changeRole.mutate({ userId: member.user_id, role: event.target.value as ClientUserRole })}
                      >
                        {!ROLES.some((role) => role.value === member.role) && <option value={member.role} disabled>{LEGACY_ROLE_LABELS[member.role]}</option>}
                        {ROLES.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
                      </Select>
                    </div>
                    {active ? (
                      <>
                        <Button
                          size="small"
                          variant="secondary"
                          loading={issueLink.isPending && issueLink.variables?.userId === member.user_id}
                          onClick={() => issueLink.mutate({ userId: member.user_id, email: member.email ?? "" })}
                        >
                          <KeyRound aria-hidden="true" className="h-4 w-4" /> Password link
                        </Button>
                        <ConfirmButton
                          title="Remove access?"
                          description={`${label} will lose access to this client immediately. Their account and the client's data are kept, and you can restore access later.`}
                          confirmLabel="Remove access"
                          variant="ghost"
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
                          <UserX aria-hidden="true" className="h-4 w-4" /><span className="sr-only">Remove access for {label}</span>
                        </ConfirmButton>
                      </>
                    ) : (
                      <Button size="small" variant="secondary" disabled={!tenantActive || !member.email} loading={restore.isPending && restore.variables?.user_id === member.user_id} onClick={() => restore.mutate(member)}>
                        <UserRoundCheck aria-hidden="true" className="h-4 w-4" /> Restore access
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </QueryView>
      </SectionCard>

      <PasswordLinkDialog issued={issued} onClose={() => setIssued(null)} />
    </div>
  );
}

function PasswordLinkDialog({ issued, onClose }: { issued: IssuedLink | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Copy failed. Select the link and copy it manually.");
    }
  };
  return (
    <Dialog open={Boolean(issued)} onOpenChange={(open) => { if (!open) { setCopied(false); onClose(); } }}>
      <DialogContent>
        <DialogTitle>Password link for {issued?.email}</DialogTitle>
        <DialogDescription>
          Send this link only to {issued?.email}. It lets them choose their own password, works once and expires soon.
          It is shown only now; create a new one if it is lost or expires.
        </DialogDescription>
        <div className="mt-5 space-y-3">
          <label className="sr-only" htmlFor="password-link">Password link</label>
          <Input id="password-link" readOnly value={issued?.url ?? ""} onFocus={(event) => event.currentTarget.select()} className="font-mono text-xs" />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => { setCopied(false); onClose(); }}>Done</Button>
            <Button onClick={() => void copy()}>
              {copied ? <Check aria-hidden="true" className="h-4 w-4" /> : <Copy aria-hidden="true" className="h-4 w-4" />}
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
