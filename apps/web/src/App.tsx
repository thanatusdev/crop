import { Navigate, Outlet, Route, BrowserRouter, Routes } from "react-router-dom";
import { UserRole } from "@crop/shared";
import { AuthProvider, useAuth } from "./lib/auth-context.js";
import { TooltipProvider } from "./components/ui/tooltip.js";
import { Toaster } from "./components/ui/sonner.js";
import LoginPage from "./pages/LoginPage.js";
import RecoveryPage from "./pages/RecoveryPage.js";
import ActivateAccountPage from "./pages/ActivateAccountPage.js";
import ForcePasswordChangePage from "./pages/ForcePasswordChangePage.js";
import DashboardPage from "./pages/DashboardPage.js";
import WorkstationPage from "./pages/WorkstationPage.js";
import ClinicHomePage from "./pages/ClinicHomePage.js";
import NursingPage from "./pages/NursingPage.js";
import ExamPage from "./pages/ExamPage.js";
import SessionPage from "./pages/SessionPage.js";
import SessionReplayPage from "./pages/SessionReplayPage.js";
import AuditPage from "./pages/AuditPage.js";
import AdminUsersPage from "./pages/AdminUsersPage.js";
import UserFormPage from "./pages/UserFormPage.js";
import AdminEquipmentPage from "./pages/AdminEquipmentPage.js";
import EquipmentFormPage from "./pages/EquipmentFormPage.js";
import AdminUnitsPage from "./pages/AdminUnitsPage.js";
import AgreementsPage from "./pages/AgreementsPage.js";
import UnitFormPage from "./pages/UnitFormPage.js";
import AdminClinicsPage from "./pages/AdminClinicsPage.js";
import ClinicFormPage from "./pages/ClinicFormPage.js";
import AdminOperatorsPage from "./pages/AdminOperatorsPage.js";
import OperatorFormPage from "./pages/OperatorFormPage.js";
import LatencyClockPage from "./pages/LatencyClockPage.js";

function ProtectedLayout() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}

/**
 * Role-gates a subtree beyond mere authentication. Previously /admin/*, /superadmin/* (and
 * now /clinica) were reachable by any authenticated role client-side -- the API's own
 * @Roles guards still rejected the actual requests, so this was never a real authorization
 * hole, just a bad UX: a logged-in OPERATOR could navigate straight to a page shell that
 * immediately 403s on every fetch it makes. Each `allowed` list below mirrors the matching
 * controller's own @Roles exactly (see packages/shared/src/roles.ts for the role families);
 * keep them in sync if those change.
 */
function RoleRoute({ allowed }: { allowed: readonly UserRole[] }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (!allowed.includes(user.role)) return <Navigate to="/" replace />;
  return <Outlet />;
}

export default function App() {
  return (
    <AuthProvider>
      {/* One `TooltipProvider`/`Toaster` for the whole app -- shadcn's own recommended
          placement, so any page can use `Tooltip`/`toast()` without mounting its own
          provider. `Toaster` renders nothing until something calls `toast(...)`. */}
      <TooltipProvider>
        <BrowserRouter>
          <Routes>
          {/* Public, deliberately outside AuthProvider's protected shell -- see the page's
              own docstring: it's opened on the target machine, not by a logged-in operator. */}
          <Route path="/latency-clock" element={<LatencyClockPage />} />
          <Route path="/login" element={<LoginPage />} />
          {/* Public: reachable from LoginPage's "Esqueci a senha" before anyone is signed in. */}
          <Route path="/recuperar-senha" element={<RecoveryPage />} />
          {/* Public: the "Enviar Convite Seguro" link an admin's POST /users sends -- see
              SendInvitationHandler. Reached by a brand-new, not-yet-authenticated user. */}
          <Route path="/ativar-conta" element={<ActivateAccountPage />} />
          {/* Public, deliberately outside ProtectedLayout: reached mid-login, before any
              session tokens exist -- see the page's own docstring on why its changeToken
              travels via router state and why that means a reload bounces back to /login
              rather than re-showing this page. */}
          <Route path="/trocar-senha" element={<ForcePasswordChangePage />} />
          <Route element={<ProtectedLayout />}>
            <Route path="/" element={<DashboardPage />} />
            {/* OPERATOR's real post-login home (see role-routes.ts) -- picks the unit and
                room for the shift, then confirms into that room's scoped "/" (see this
                page's own docstring). Gated to OPERATOR only: OPERATOR_ADMIN and
                OPERATIONAL_SUPERVISOR keep "/" itself as their working home, matching
                role-routes.ts, which leaves both there. */}
            <Route element={<RoleRoute allowed={[UserRole.OPERATOR]} />}>
              <Route path="/posto-de-trabalho" element={<WorkstationPage />} />
            </Route>
            <Route path="/sessions/:sessionId" element={<SessionPage />} />
            <Route path="/sessions/:sessionId/replay" element={<SessionReplayPage />} />
            {/* The operator's own equipment-scoped exam cockpit -- see ExamPage's own
                docstring for why this is `?equipmentId=`-scoped rather than a `:sessionId`
                route like SessionPage above, which this does not replace or redirect. */}
            <Route path="/exame" element={<ExamPage />} />
            {/* Mirrors AuditController's @Roles. */}
            <Route
              element={
                <RoleRoute
                  allowed={[
                    UserRole.AUDITOR,
                    UserRole.OPERATIONAL_SUPERVISOR,
                    UserRole.LOCAL_SUPERVISOR,
                    UserRole.CLINIC_ADMIN,
                    UserRole.OPERATOR_ADMIN,
                    UserRole.PLATFORM_ADMIN,
                  ]}
                />
              }
            >
              <Route path="/audit" element={<AuditPage />} />
            </Route>
            {/* Mirrors UsersController's @Roles. LOCAL_SUPERVISOR included -- they can grant
                NURSING/LOCAL_IT per ROLE_GRANTS and the backend already authorizes them;
                this route list is what used to leave them with a nav link to nowhere. */}
            <Route
              element={
                <RoleRoute
                  allowed={[UserRole.CLINIC_ADMIN, UserRole.LOCAL_SUPERVISOR, UserRole.OPERATOR_ADMIN, UserRole.PLATFORM_ADMIN]}
                />
              }
            >
              <Route path="/admin/users" element={<AdminUsersPage />} />
              {/* Same shape as the equipment/unit/clinic blocks: `/admin/users/:id` alone
                  is the read-only view, `:mode` a literal `edit` segment. */}
              <Route path="/admin/users/new" element={<UserFormPage />} />
              <Route path="/admin/users/:id" element={<UserFormPage />} />
              <Route path="/admin/users/:id/:mode" element={<UserFormPage />} />
            </Route>
            {/* Mirrors EquipmentController's POST/@Roles -- LOCAL_IT included, unlike
                /admin/users above, since it has equipment permissions but not user ones. */}
            <Route
              element={
                <RoleRoute
                  allowed={[UserRole.CLINIC_ADMIN, UserRole.LOCAL_SUPERVISOR, UserRole.LOCAL_IT, UserRole.PLATFORM_ADMIN]}
                />
              }
            >
              <Route path="/admin/equipment" element={<AdminEquipmentPage />} />
              {/* Register / edit / view one device. `:mode` is a literal `edit` segment, not a
                  free parameter -- `/admin/equipment/:id` alone is the read-only view, and
                  EquipmentFormPage treats anything other than `edit` there as view mode. */}
              <Route path="/admin/equipment/new" element={<EquipmentFormPage />} />
              <Route path="/admin/equipment/:id" element={<EquipmentFormPage />} />
              <Route path="/admin/equipment/:id/:mode" element={<EquipmentFormPage />} />
            </Route>
            {/* Mirrors UnitsController's POST/@Roles -- identical set to /admin/equipment
                above (provisioning a unit is the same kind of clinic-administration action). */}
            <Route
              element={
                <RoleRoute
                  allowed={[UserRole.CLINIC_ADMIN, UserRole.LOCAL_SUPERVISOR, UserRole.LOCAL_IT, UserRole.PLATFORM_ADMIN]}
                />
              }
            >
              <Route path="/admin/units" element={<AdminUnitsPage />} />
              {/* Same shape as the equipment block above: `/admin/units/:id` alone is the
                  read-only view, `:mode` a literal `edit` segment. */}
              <Route path="/admin/units/new" element={<UnitFormPage />} />
              <Route path="/admin/units/:id" element={<UnitFormPage />} />
              <Route path="/admin/units/:id/:mode" element={<UnitFormPage />} />
            </Route>
            {/* Mirrors TenantsController's @Roles -- PLATFORM_ADMIN only. Renamed from
                `/superadmin/tenants`: this route now specifically manages CLINIC tenants
                (see AdminClinicsPage's own docstring) -- `GET /tenants` itself still returns
                every tenant type unchanged, only this route's own filtering narrowed. */}
            <Route element={<RoleRoute allowed={[UserRole.PLATFORM_ADMIN]} />}>
              <Route path="/superadmin/clinics" element={<AdminClinicsPage />} />
              {/* Same shape as the equipment/unit blocks above: `/superadmin/clinics/:id`
                  alone is the read-only view, `:mode` a literal `edit` segment. */}
              <Route path="/superadmin/clinics/new" element={<ClinicFormPage />} />
              <Route path="/superadmin/clinics/:id" element={<ClinicFormPage />} />
              <Route path="/superadmin/clinics/:id/:mode" element={<ClinicFormPage />} />
              {/* OPERATOR_PROVIDER's own registry, same shape as clinics above -- see
                  AdminOperatorsPage's own docstring. */}
              <Route path="/superadmin/operadoras" element={<AdminOperatorsPage />} />
              <Route path="/superadmin/operadoras/new" element={<OperatorFormPage />} />
              <Route path="/superadmin/operadoras/:id" element={<OperatorFormPage />} />
              <Route path="/superadmin/operadoras/:id/:mode" element={<OperatorFormPage />} />
            </Route>
            {/* Mirrors AgreementsController's @Roles: the administrator of each side of the
                contract plus PLATFORM_ADMIN. One route for both sides -- see AgreementsPage's
                own docstring for why this is one screen and not two. */}
            <Route
              element={
                <RoleRoute
                  allowed={[UserRole.CLINIC_ADMIN, UserRole.LOCAL_SUPERVISOR, UserRole.OPERATOR_ADMIN, UserRole.PLATFORM_ADMIN]}
                />
              }
            >
              <Route path="/contratos" element={<AgreementsPage />} />
            </Route>
            {/* The clinic-staff roles that still have no dedicated screen of their own (see
                ClinicHomePage's own docstring) -- NURSING moved off this stub to
                /enfermagem once its own screen existed. */}
            <Route element={<RoleRoute allowed={[UserRole.LOCAL_SUPERVISOR, UserRole.LOCAL_IT]} />}>
              <Route path="/clinica" element={<ClinicHomePage />} />
            </Route>
            {/* Mirrors QueueController's POST :id/preparation @Roles -- the nursing
                quick-action write route, not the broader class-level read/list roles (see
                that controller's own comment for why the write is narrower). */}
            <Route
              element={<RoleRoute allowed={[UserRole.NURSING, UserRole.LOCAL_SUPERVISOR, UserRole.CLINIC_ADMIN, UserRole.PLATFORM_ADMIN]} />}
            >
              <Route path="/enfermagem" element={<NursingPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
        <Toaster />
      </TooltipProvider>
    </AuthProvider>
  );
}
