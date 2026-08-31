import { Navigate, Outlet, Route, BrowserRouter, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth-context.js";
import LoginPage from "./pages/LoginPage.js";
import DashboardPage from "./pages/DashboardPage.js";
import SessionPage from "./pages/SessionPage.js";
import SessionReplayPage from "./pages/SessionReplayPage.js";
import AuditPage from "./pages/AuditPage.js";
import AdminUsersPage from "./pages/AdminUsersPage.js";
import AdminEquipmentPage from "./pages/AdminEquipmentPage.js";
import SuperadminTenantsPage from "./pages/SuperadminTenantsPage.js";
import LatencyClockPage from "./pages/LatencyClockPage.js";

function ProtectedLayout() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* Public, deliberately outside AuthProvider's protected shell -- see the page's
              own docstring: it's opened on the target machine, not by a logged-in operator. */}
          <Route path="/latency-clock" element={<LatencyClockPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route element={<ProtectedLayout />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/sessions/:sessionId" element={<SessionPage />} />
            <Route path="/sessions/:sessionId/replay" element={<SessionReplayPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/admin/users" element={<AdminUsersPage />} />
            <Route path="/admin/equipment" element={<AdminEquipmentPage />} />
            <Route path="/superadmin/tenants" element={<SuperadminTenantsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
