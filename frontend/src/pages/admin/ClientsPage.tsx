import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Building2, Plus, Search } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";
import { StatusBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/Dialog";
import { Field } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { EmptyState, PageHeader, QueryView } from "../../components/ui/States";
import { formatDate, slugify } from "../../lib/analytics";
import { queryKeys, useApi } from "../../lib/api/ApiProvider";
import { errorMessage } from "../../lib/api/errors";
import type { TenantInput } from "../../lib/api/types";

const optional = (schema: z.ZodString) => z.union([schema, z.literal("")]).transform((value) => (value === "" ? null : value));

export const tenantSchema = z.object({
  business_name: z.string().trim().min(1, "Enter the business name.").max(200),
  slug: z
    .string()
    .trim()
    .min(2, "Use at least 2 characters.")
    .max(63)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens."),
  email: optional(z.string().trim().email("Enter a valid email address.").max(254)),
  industry: optional(z.string().trim().max(120)),
  website: optional(z.string().trim().max(300).regex(/^https?:\/\/\S+$/, "Start with https://")),
  primary_contact_name: optional(z.string().trim().max(160)),
});

type TenantFormInput = z.input<typeof tenantSchema>;

export function ClientsPage() {
  const api = useApi();
  const [search, setSearch] = useState("");
  const tenants = useQuery({ queryKey: queryKeys.tenants, queryFn: () => api.listTenants() });
  const runs = useQuery({ queryKey: queryKeys.auditRuns(), queryFn: () => api.listAuditRuns() });
  const latestScore = new Map<string, number | null>();
  for (const run of runs.data ?? []) {
    if (run.status === "published" && !latestScore.has(run.tenant_id)) latestScore.set(run.tenant_id, run.overall_score);
  }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Clients" title="Client organizations" description="Every client is an isolated tenant: their users only ever see their own data." actions={<CreateClientButton />} />
      <Card className="overflow-hidden">
        <div className="border-b border-slate-100 p-4">
          <div className="relative max-w-sm">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <label htmlFor="client-search" className="sr-only">Search clients</label>
            <Input id="client-search" className="pl-9" placeholder="Search by name or slug" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
        </div>
        <QueryView query={tenants} empty={<EmptyState icon={<Building2 />} title="No clients yet" description="Create the first client organization to start onboarding." action={<CreateClientButton />} />}>
          {(items) => {
            const filtered = items.filter((tenant) => `${tenant.business_name} ${tenant.slug}`.toLowerCase().includes(search.toLowerCase()));
            if (filtered.length === 0) return <EmptyState title="No matching clients" />;
            return (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th scope="col" className="px-5 py-3 font-medium">Client</th>
                      <th scope="col" className="px-3 py-3 font-medium">Industry</th>
                      <th scope="col" className="px-3 py-3 font-medium">Status</th>
                      <th scope="col" className="px-3 py-3 text-right font-medium">Latest score</th>
                      <th scope="col" className="px-3 py-3 font-medium">Created</th>
                      <th scope="col" className="px-5 py-3"><span className="sr-only">Open</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filtered.map((tenant) => (
                      <tr key={tenant.id} className="hover:bg-slate-50/70">
                        <td className="px-5 py-3">
                          <Link to={`/admin/clients/${tenant.id}`} className="font-medium text-ink-950 hover:text-accent-700">{tenant.business_name}</Link>
                          <p className="text-xs text-slate-500">{tenant.slug}</p>
                        </td>
                        <td className="px-3 py-3 text-slate-600">{tenant.industry ?? "–"}</td>
                        <td className="px-3 py-3"><StatusBadge status={tenant.status} /></td>
                        <td className="px-3 py-3 text-right font-semibold tabular-nums">{latestScore.has(tenant.id) ? Math.round(latestScore.get(tenant.id) ?? 0) : "–"}</td>
                        <td className="px-3 py-3 text-slate-600">{formatDate(tenant.created_at)}</td>
                        <td className="px-5 py-3 text-right">
                          <Link to={`/admin/clients/${tenant.id}`} className="inline-flex items-center gap-1 font-medium text-accent-700">Manage <ArrowUpRight aria-hidden="true" className="h-4 w-4" /></Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }}
        </QueryView>
      </Card>
    </div>
  );
}

function CreateClientButton() {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);
  const form = useForm<TenantFormInput, unknown, TenantInput>({
    resolver: zodResolver(tenantSchema),
    defaultValues: { business_name: "", slug: "", email: "", industry: "", website: "", primary_contact_name: "" },
  });
  const create = useMutation({
    mutationFn: (values: TenantInput) => api.createTenant(values),
    onSuccess: (tenant) => {
      toast.success(`${tenant.business_name} created`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.tenants });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      setOpen(false);
      form.reset();
      navigate(`/admin/clients/${tenant.id}?tab=team`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const errors = form.formState.errors;
  const nameField = form.register("business_name");
  return (
    <>
      <Button onClick={() => setOpen(true)}><Plus aria-hidden="true" className="h-4 w-4" /> New client</Button>
      <Dialog open={open} onOpenChange={(next) => !create.isPending && setOpen(next)}>
        <DialogContent className="max-w-xl">
          <DialogTitle>New client organization</DialogTitle>
          <DialogDescription>After creating the client, invite its first owner from the Team tab.</DialogDescription>
          <form className="mt-5 grid gap-4 sm:grid-cols-2" noValidate onSubmit={form.handleSubmit((values) => create.mutate(values))}>
            <div className="sm:col-span-2">
              <Field label="Business name" htmlFor="client-name" error={errors.business_name?.message}>
                <Input
                  id="client-name"
                  {...nameField}
                  onChange={(event) => {
                    void nameField.onChange(event);
                    if (!slugEdited) form.setValue("slug", slugify(event.target.value), { shouldValidate: form.formState.isSubmitted });
                  }}
                />
              </Field>
            </div>
            <Field label="Workspace slug" htmlFor="client-slug" error={errors.slug?.message} hint="Used in the client's portal address.">
              <Input id="client-slug" {...form.register("slug", { onChange: () => setSlugEdited(true) })} />
            </Field>
            <Field label="Industry" htmlFor="client-industry" error={errors.industry?.message}>
              <Input id="client-industry" {...form.register("industry")} />
            </Field>
            <Field label="Primary contact" htmlFor="client-contact" error={errors.primary_contact_name?.message}>
              <Input id="client-contact" {...form.register("primary_contact_name")} />
            </Field>
            <Field label="Contact email" htmlFor="client-email" error={errors.email?.message}>
              <Input id="client-email" type="email" {...form.register("email")} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Website" htmlFor="client-website" error={errors.website?.message}>
                <Input id="client-website" placeholder="https://" {...form.register("website")} />
              </Field>
            </div>
            <div className="flex justify-end gap-2 sm:col-span-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={create.isPending}>Cancel</Button>
              <Button type="submit" loading={create.isPending}>Create client</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
