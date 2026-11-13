import { Suspense, lazy, type ReactNode } from "react";
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "../components/ui/Button";
import { LoadingState } from "../components/ui/LoadingState";
import { useAuth } from "../context/AuthProvider";
import { PortalLayout } from "../components/layout/PortalLayout";

const AcceptInvitePage = lazy(() => import("../pages/auth/AcceptInvitePage").then((module) => ({ default: module.AcceptInvitePage })));
const ForgotPasswordPage = lazy(() => import("../pages/auth/ForgotPasswordPage").then((module) => ({ default: module.ForgotPasswordPage })));
const LoginPage = lazy(() => import("../pages/auth/LoginPage").then((module) => ({ default: module.LoginPage })));
const MfaPage = lazy(() => import("../pages/auth/MfaPage").then((module) => ({ default: module.MfaPage })));
const ResetPasswordPage = lazy(() => import("../pages/auth/ResetPasswordPage").then((module) => ({ default: module.ResetPasswordPage })));
const ClientDashboard = lazy(() => import("../pages/client/ClientDashboard").then((module) => ({ default: module.ClientDashboard })));
const StaffDashboard = lazy(() => import("../pages/admin/StaffDashboard").then((module) => ({ default: module.StaffDashboard })));
const ClientsPage = lazy(() => import("../pages/admin/ClientsPage").then((module) => ({ default: module.ClientsPage })));
const ClientDetailPage = lazy(() => import("../pages/admin/ClientDetailPage").then((module) => ({ default: module.ClientDetailPage })));
const ConnectionsPage = lazy(() => import("../pages/admin/ConnectionsPage").then((module) => ({ default: module.ConnectionsPage })));
const AuditsPage = lazy(() => import("../pages/admin/AuditsPage").then((module) => ({ default: module.AuditsPage })));
const ReportsPage = lazy(() => import("../pages/admin/AuditsPage").then((module) => ({ default: module.ReportsPage })));
const AuditReviewPage = lazy(() => import("../pages/admin/AuditReviewPage").then((module) => ({ default: module.AuditReviewPage })));
const ActivityPage = lazy(() => import("../pages/admin/ActivityPage").then((module) => ({ default: module.ActivityPage })));
const AdAccountsPage = lazy(() => import("../pages/client/ClientPages").then((module) => ({ default: module.AdAccountsPage })));
const CampaignsPage = lazy(() => import("../pages/client/ClientPages").then((module) => ({ default: module.CampaignsPage })));
const ClientAuditsPage = lazy(() => import("../pages/client/ClientPages").then((module) => ({ default: module.ClientAuditsPage })));
const ClientAuditDetailPage = lazy(() => import("../pages/client/ClientPages").then((module) => ({ default: module.ClientAuditDetailPage })));
const ClientReportsPage = lazy(() => import("../pages/client/ClientPages").then((module) => ({ default: module.ClientReportsPage })));
const TeamPage = lazy(() => import("../pages/client/ClientPages").then((module) => ({ default: module.TeamPage })));
const OAuthCallbackPage = lazy(() => import("../pages/OAuthCallbackPage").then((module) => ({ default: module.OAuthCallbackPage })));
// Statically removed from non-demo builds (Vite replaces import.meta.env.MODE).
const DemoLoginPage = import.meta.env.MODE === "demo" || import.meta.env.MODE === "test"
  ? lazy(() => import("../demo/DemoLoginPage").then((module) => ({ default: module.DemoLoginPage })))
  : null;

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<LoadingState />}>
        <Routes>
          <Route path="/login" element={<GuestOnly><LoginRoute /></GuestOnly>} />
          <Route path="/forgot-password" element={<GuestOnly><ForgotPasswordPage /></GuestOnly>} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/accept-invite" element={<AcceptInvitePage />} />
          <Route path="/mfa" element={<AuthenticatedGate allowMfaStepUp><MfaPage /></AuthenticatedGate>} />
          <Route path="/mfa/setup" element={<MfaEnrollmentGate />} />

          <Route element={<AuthenticatedGate />}>
            <Route path="/oauth/callback" element={<OAuthCallbackPage />} />
            <Route path="/admin" element={<PlatformAdminGate />}>
              <Route element={<PortalLayout portal="staff" />}>
                <Route index element={<StaffDashboard />} />
                <Route path="clients" element={<ClientsPage />} />
                <Route path="clients/:tenantId" element={<ClientDetailPage />} />
                <Route path="connections" element={<ConnectionsPage />} />
                <Route path="audits" element={<AuditsPage />} />
                <Route path="audits/:auditId" element={<AuditReviewPage />} />
                <Route path="reports" element={<ReportsPage />} />
                <Route path="activity" element={<ActivityPage />} />
              </Route>
            </Route>
            <Route path="/app/:tenantSlug" element={<ClientAccessGate />}>
              <Route element={<PortalLayout portal="client" />}>
                <Route index element={<ClientDashboard />} />
                <Route path="accounts" element={<AdAccountsPage />} />
                <Route path="campaigns" element={<CampaignsPage />} />
                <Route path="audits" element={<ClientAuditsPage />} />
                <Route path="audits/:auditId" element={<ClientAuditDetailPage />} />
                <Route path="reports" element={<ClientReportsPage />} />
                <Route path="team" element={<TeamPage />} />
              </Route>
            </Route>
            <Route path="/" element={<HomeRedirect />} />
            <Route path="/no-workspace" element={<NoWorkspace />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

function LoginRoute() {
  const { demo } = useAuth();
  return demo && DemoLoginPage ? <DemoLoginPage /> : <LoginPage />;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { user, authLoading, contextLoading } = useAuth();
  const location = useLocation();
  if (authLoading || (user && contextLoading)) return <LoadingState />;
  if (user) {
    const state = location.state as { from?: { pathname?: string }; invitationToken?: string } | null;
    if (state?.invitationToken) {
      return <Navigate to="/accept-invite" replace state={{ invitationToken: state.invitationToken }} />;
    }
    return <Navigate to={state?.from?.pathname ?? "/"} replace />;
  }
  return children;
}

function AuthenticatedGate({
  children,
  allowMfaStepUp = false,
}: {
  children?: ReactNode;
  allowMfaStepUp?: boolean;
}) {
  const { user, authLoading, contextLoading, context, contextError } = useAuth();
  const location = useLocation();
  if (authLoading) return <LoadingState label="Restoring your secure session…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  if (contextLoading) return <LoadingState label="Loading your account access…" />;
  if (contextError || !context) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-5">
        <div className="max-w-lg rounded-xl border border-rose-200 bg-white p-7 shadow-card">
          <h1 className="text-lg font-semibold text-ink-950">Account access unavailable</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">{contextError ?? "Your account context could not be loaded."}</p>
          <Button className="mt-5" variant="secondary" onClick={() => window.location.reload()}>Try again</Button>
        </div>
      </main>
    );
  }
  if (context.platform_admin_mfa_required && !allowMfaStepUp) return <Navigate to="/mfa" replace />;
  if (allowMfaStepUp && !context.platform_admin_mfa_required && context.is_platform_admin) return <Navigate to="/admin" replace />;
  if (allowMfaStepUp && !context.platform_admin_mfa_required && !context.is_platform_admin) return <Navigate to="/" replace />;
  return children ?? <Outlet />;
}

function MfaEnrollmentGate() {
  const { user, authLoading } = useAuth();
  const location = useLocation();
  if (authLoading) return <LoadingState label="Restoring your secure session…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return <MfaPage bootstrapEnrollment />;
}

function PlatformAdminGate() {
  const { context } = useAuth();
  if (!context?.is_platform_admin) return <NoWorkspace staffRequired />;
  return <Outlet />;
}

function ClientAccessGate() {
  const { memberships } = useAuth();
  const { tenantSlug } = useParams();
  const membership = memberships.find((item) => item.slug === tenantSlug);
  if (!membership) return <NoWorkspace />;
  if (membership.tenant_status !== "active") return <SuspendedWorkspace name={membership.business_name} />;
  return <Outlet />;
}

function HomeRedirect() {
  const { context, memberships } = useAuth();
  if (context?.is_platform_admin) return <Navigate to="/admin" replace />;
  const activeMembership = memberships.find((membership) => membership.tenant_status === "active");
  if (activeMembership) return <Navigate to={`/app/${activeMembership.slug}`} replace />;
  if (memberships.length > 0) return <SuspendedWorkspace name={memberships[0].business_name} />;
  return <NoWorkspace />;
}

function NoWorkspace({ staffRequired = false }: { staffRequired?: boolean }) {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const logOut = async () => {
    try {
      await signOut();
      navigate("/login", { replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't sign you out.");
    }
  };
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-5">
      <div className="max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-card">
        <h1 className="text-xl font-semibold text-ink-950">
          {staffRequired ? "Staff access required" : "No workspace assigned"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          {staffRequired
            ? "This area is only available to verified PRISIM platform administrators."
            : "Your account doesn’t have an active client workspace yet. Contact your PRISIM administrator for an invitation."}
        </p>
        {!staffRequired && (
          <Link to="/mfa/setup" className="mt-4 inline-flex text-sm font-semibold text-accent-700 hover:text-accent-800">
            Set up an authenticator
          </Link>
        )}
        <Button
          className="mt-6"
          variant="secondary"
          onClick={() => void logOut()}
        >
          Sign out
        </Button>
      </div>
    </main>
  );
}

function SuspendedWorkspace({ name }: { name: string }) {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const logOut = async () => {
    try {
      await signOut();
      navigate("/login", { replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't sign you out.");
    }
  };
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-5">
      <div className="max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-card">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Workspace unavailable</p>
        <h1 className="mt-3 text-xl font-semibold text-ink-950">{name}</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          This workspace is not currently active. Contact your PRISIM account representative for assistance.
        </p>
        <Button className="mt-6" variant="secondary" onClick={() => void logOut()}>
          Sign out
        </Button>
      </div>
    </main>
  );
}

function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-5">
      <div className="text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent-700">404</p>
        <h1 className="mt-2 text-2xl font-semibold text-ink-950">Page not found</h1>
        <p className="mt-2 text-sm text-slate-500">The page you’re looking for isn’t available.</p>
        <Button className="mt-6" variant="secondary" onClick={() => window.location.assign("/")}>Go to your workspace</Button>
      </div>
    </main>
  );
}
