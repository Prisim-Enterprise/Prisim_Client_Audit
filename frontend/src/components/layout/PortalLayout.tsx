import {
  Activity,
  ArrowUpRight,
  BarChart3,
  ChevronDown,
  CircleHelp,
  FileText,
  LayoutDashboard,
  Link2,
  LogOut,
  Menu,
  ShieldCheck,
  TriangleAlert,
  UserCog,
  Users,
  X,
} from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Brand } from "../Brand";
import { Button } from "../ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/DropdownMenu";
import { useAuth } from "../../context/AuthProvider";
import { cn } from "../../lib/utils";

type Portal = "staff" | "client";

const staffNavigation = [
  { label: "Overview", path: "", icon: LayoutDashboard },
  { label: "Clients", path: "clients", icon: Users },
  { label: "Connections", path: "connections", icon: Link2 },
  { label: "Audits", path: "audits", icon: ShieldCheck },
  { label: "Reports", path: "reports", icon: FileText },
  { label: "Activity", path: "activity", icon: Activity },
];

const clientNavigation = [
  { label: "Overview", path: "", icon: LayoutDashboard },
  { label: "Ad accounts", path: "accounts", icon: Link2 },
  { label: "Campaigns", path: "campaigns", icon: BarChart3 },
  { label: "Audit findings", path: "audits", icon: ShieldCheck },
  { label: "Reports", path: "reports", icon: FileText },
  { label: "Team", path: "team", icon: UserCog, minimumRole: "admin" as const },
];

export function PortalLayout({ portal }: { portal: Portal }) {
  const { user, profile, memberships, setCurrentTenant, signOut, demo } = useAuth();
  const { tenantSlug } = useParams();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const currentMembership = memberships.find((membership) => membership.slug === tenantSlug) ?? null;
  const canManageTeam = currentMembership ? ["owner", "admin"].includes(currentMembership.role) : false;
  const navigation = portal === "staff"
    ? staffNavigation
    : clientNavigation.filter((item) => !("minimumRole" in item) || canManageTeam);
  const root = portal === "staff" ? "/admin" : `/app/${tenantSlug}`;
  const displayName = profile?.full_name?.trim() || user?.email?.split("@")[0] || "Account";
  const initials = displayName.slice(0, 1).toUpperCase();

  const logOut = async () => {
    try {
      await signOut();
      navigate("/login", { replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't sign you out.");
    }
  };

  const changeWorkspace = (tenantId: string) => {
    const membership = memberships.find((item) => item.tenant_id === tenantId);
    if (!membership) return;
    setCurrentTenant(tenantId);
    navigate(`/app/${membership.slug}`);
    setMobileOpen(false);
  };

  return (
    <div className="min-h-screen bg-[#f6f8fa]">
      {demo && (
        <div role="status" className="relative z-50 flex items-center justify-center gap-2 bg-amber-400 px-4 py-1.5 text-center text-xs font-semibold text-amber-950">
          <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          DEMO MODE — synthetic data only, not real client results. Nothing is saved or sent.
        </div>
      )}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[252px] flex-col bg-ink-950 text-white lg:flex">
        <div className="flex h-[76px] items-center border-b border-white/[0.08] px-6">
          <Brand light />
        </div>
        <div className="px-4 pt-7">
          <p className="px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            {portal === "staff" ? "Staff workspace" : "Client workspace"}
          </p>
          {portal === "client" && currentMembership && (
            <div className="mt-3 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-3">
              <p className="truncate text-sm font-medium text-white">{currentMembership.business_name}</p>
              <p className="mt-1 text-xs capitalize text-slate-400">{currentMembership.role} access</p>
            </div>
          )}
        </div>
        <nav aria-label="Primary navigation" className="mt-5 flex-1 space-y-1 px-3">
          {navigation.map(({ label, path, icon: Icon }) => (
            <NavLink
              key={label}
              end={!path}
              to={path ? `${root}/${path}` : root}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                  isActive ? "bg-white/[0.1] font-medium text-white" : "text-slate-400 hover:bg-white/[0.06] hover:text-white",
                )
              }
            >
              <Icon aria-hidden="true" className="h-[17px] w-[17px]" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/[0.08] p-4">
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-500/20 text-sm font-semibold text-accent-100">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">{displayName}</p>
              <p className="truncate text-xs text-slate-400">{portal === "staff" ? "Platform administrator" : user?.email}</p>
            </div>
            <button type="button" onClick={() => void logOut()} aria-label="Sign out" className="rounded-md p-2 text-slate-400 hover:bg-white/[0.08] hover:text-white">
              <LogOut aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" aria-label="Close navigation" onClick={() => setMobileOpen(false)} className="absolute inset-0 bg-ink-950/45" />
          <aside className="relative flex h-full w-[min(84vw,300px)] flex-col bg-ink-950 text-white shadow-xl">
            <div className="flex h-[76px] items-center justify-between border-b border-white/[0.08] px-5">
              <Brand light />
              <button type="button" aria-label="Close menu" onClick={() => setMobileOpen(false)} className="rounded p-2 text-slate-300 hover:bg-white/10">
                <X aria-hidden="true" className="h-5 w-5" />
              </button>
            </div>
            <nav aria-label="Mobile navigation" className="flex-1 space-y-1 px-3 py-6">
              {navigation.map(({ label, path, icon: Icon }) => (
                <NavLink key={label} end={!path} to={path ? `${root}/${path}` : root} onClick={() => setMobileOpen(false)} className={({ isActive }) => cn("flex items-center gap-3 rounded-lg px-3 py-3 text-sm", isActive ? "bg-white/[0.1] font-medium text-white" : "text-slate-400 hover:bg-white/[0.06] hover:text-white")}>
                  <Icon aria-hidden="true" className="h-4 w-4" /> {label}
                </NavLink>
              ))}
            </nav>
            <div className="border-t border-white/[0.08] p-4">
              <p className="truncate text-sm text-slate-300">{user?.email}</p>
              <Button variant="ghost" className="mt-3 w-full justify-start text-slate-300 hover:text-white" onClick={() => void logOut()}>
                <LogOut aria-hidden="true" className="h-4 w-4" /> Sign out
              </Button>
            </div>
          </aside>
        </div>
      )}

      <div className="min-h-screen lg:pl-[252px]">
        <header className="sticky top-0 z-20 flex h-[76px] items-center justify-between border-b border-slate-200/80 bg-white/95 px-4 backdrop-blur sm:px-7 lg:px-9">
          <div className="flex min-w-0 items-center gap-3">
            <button type="button" aria-label="Open navigation" onClick={() => setMobileOpen(true)} className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden">
              <Menu aria-hidden="true" className="h-5 w-5" />
            </button>
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.17em] text-slate-400 lg:hidden">
                {portal === "staff" ? "Staff portal" : "Client portal"}
              </p>
              <p className="hidden text-sm font-medium text-slate-600 lg:block">
                {portal === "staff" ? "PRISIM Staff Portal" : "Client Portal"}
              </p>
              <p className="truncate text-sm font-semibold text-ink-950 lg:hidden">
                {portal === "staff" ? "PRISIM" : currentMembership?.business_name}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {portal === "client" && memberships.filter((item) => item.tenant_status === "active").length > 1 && (
              <div className="relative">
                <label htmlFor="workspace-switcher" className="sr-only">Switch workspace</label>
                <select
                  id="workspace-switcher"
                  value={currentMembership?.tenant_id ?? ""}
                  onChange={(event) => changeWorkspace(event.target.value)}
                  className="max-w-[170px] appearance-none rounded-lg border border-slate-200 bg-white py-2 pl-3 pr-8 text-xs font-medium text-slate-700 outline-none focus:border-accent-500 focus:ring-2 focus:ring-accent-100 sm:max-w-[220px] sm:text-sm"
                >
                  {memberships.filter((item) => item.tenant_status === "active").map((item) => (
                    <option key={item.tenant_id} value={item.tenant_id}>{item.business_name}</option>
                  ))}
                </select>
                <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              </div>
            )}
            <a href="mailto:support@prisim.in" className="hidden items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-500 hover:bg-slate-100 hover:text-ink-950 sm:inline-flex">
              <CircleHelp aria-hidden="true" className="h-4 w-4" /> Help
            </a>
            {portal === "staff" && (
              <span className="hidden items-center gap-1.5 rounded-full bg-accent-50 px-3 py-1.5 text-xs font-medium text-accent-700 sm:inline-flex">
                <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" /> {demo ? "Demo staff session" : "MFA verified"}
              </span>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Open account menu"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-ink-950 text-sm font-semibold text-white outline-none ring-offset-2 focus-visible:ring-2 focus-visible:ring-accent-500"
                >
                  {initials}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>
                  <span className="block font-medium text-ink-950">{displayName}</span>
                  <span className="mt-1 block max-w-56 truncate font-normal">{user?.email}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void logOut()}>
                  <LogOut aria-hidden="true" className="h-4 w-4" /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="mx-auto max-w-[1440px] px-4 py-7 sm:px-7 sm:py-9 lg:px-9">
          <Outlet />
        </main>
        <footer className="flex flex-col gap-2 border-t border-slate-200/80 px-5 py-5 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between sm:px-9">
          <span>PRISIM Client Audit Portal</span>
          <a href="https://prisim.in" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-slate-600">
            Powered by PRISIM <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
          </a>
        </footer>
      </div>
    </div>
  );
}
