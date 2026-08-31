import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RT_EVENTS, type EquipmentDto, type QueueEntryDto, type SessionState } from "@crop/shared";
import { api, ApiError } from "../lib/api-client.js";
import { useAuth } from "../lib/auth-context.js";
import { createSessionSocket } from "../lib/socket-client.js";

interface EquipmentWithQueue extends EquipmentDto {
  queue: QueueEntryDto[];
}

export default function DashboardPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [equipment, setEquipment] = useState<EquipmentWithQueue[]>([]);
  const [activeSessions, setActiveSessions] = useState<SessionState[]>([]);
  const [loading, setLoading] = useState(true);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newPatientName, setNewPatientName] = useState<Record<string, string>>({});
  const [queueActionId, setQueueActionId] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);

  // Mirrors AuditController's @Roles -- avoids sending an OPERATOR into a guaranteed 403.
  const canViewAudit =
    user?.role === "AUDITOR" || user?.role === "SUPERVISOR" || user?.role === "CLINIC_ADMIN" || user?.role === "PLATFORM_ADMIN";
  // Mirrors UsersController's/EquipmentController's POST @Roles -- same reasoning.
  const canManageAdmin = user?.role === "CLINIC_ADMIN" || user?.role === "PLATFORM_ADMIN";
  // Mirrors TenantsController's @Roles -- PLATFORM_ADMIN only, deliberately NOT lumped with
  // CLINIC_ADMIN like canManageAdmin above: tenant lifecycle is the one thing a CLINIC_ADMIN
  // never gets, by design.
  const canManagePlatform = user?.role === "PLATFORM_ADMIN";

  useEffect(() => {
    void load();
  }, []);

  // Live push: another user adding/cancelling a queue entry, or the health poller flipping
  // an equipment's status, would otherwise only ever show up here after a manual reload --
  // RT_EVENTS.QUEUE_UPDATED/EQUIPMENT_STATUS_CHANGED exist specifically so this doesn't have
  // to be true. Reusing createSessionSocket (not actually session-specific, just an
  // authenticated /rt connection) rather than introducing a second connection helper --
  // SessionsGateway.handleConnection auto-joins every socket to its own tenant's room, so no
  // extra subscribe step is needed here beyond just connecting.
  useEffect(() => {
    const sock = createSessionSocket();
    sock.connect();
    sock.on(RT_EVENTS.QUEUE_UPDATED, () => void load());
    sock.on(RT_EVENTS.EQUIPMENT_STATUS_CHANGED, () => void load());
    return () => {
      sock.disconnect();
    };
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [equipmentList, sessions] = await Promise.all([
        api.get<EquipmentDto[]>("/equipment"),
        api.get<SessionState[]>("/sessions/active"),
      ]);
      const withQueue = await Promise.all(
        equipmentList.map(async (e) => ({ ...e, queue: await api.get<QueueEntryDto[]>(`/queue?equipmentId=${e.id}`) }))
      );
      setEquipment(withQueue);
      setActiveSessions(sessions);
    } catch (err) {
      // Distinct from "no equipment registered" below -- an empty array here on a failed
      // fetch would otherwise be indistinguishable from a tenant that genuinely has none.
      setError(err instanceof Error ? err.message : "Could not load equipment. Check your connection and retry.");
    } finally {
      setLoading(false);
    }
  }

  function activeSessionFor(equipmentId: string): SessionState | undefined {
    return activeSessions.find((s) => s.equipmentId === equipmentId);
  }

  async function startSession(equipmentId: string, queueEntryId?: string) {
    setError(null);
    setStartingId(equipmentId);
    try {
      const session = await api.post<SessionState>("/sessions", { equipmentId, queueEntryId });
      navigate(`/sessions/${session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start session");
    } finally {
      setStartingId(null);
    }
  }

  async function addPatient(equipmentId: string, ev: React.FormEvent) {
    ev.preventDefault();
    const patientFirstName = (newPatientName[equipmentId] ?? "").trim();
    if (!patientFirstName) return;
    setQueueError(null);
    setQueueActionId(equipmentId);
    try {
      await api.post("/queue", { equipmentId, patientFirstName });
      setNewPatientName((prev) => ({ ...prev, [equipmentId]: "" }));
      await load();
    } catch (err) {
      setQueueError(err instanceof ApiError ? err.message : "Could not add this patient to the queue.");
    } finally {
      setQueueActionId(null);
    }
  }

  async function cancelQueueEntry(queueEntryId: string) {
    setQueueError(null);
    setQueueActionId(queueEntryId);
    try {
      await api.post(`/queue/${queueEntryId}/status`, { status: "CANCELLED" });
      await load();
    } catch (err) {
      setQueueError(err instanceof ApiError ? err.message : "Could not cancel this queue entry.");
    } finally {
      setQueueActionId(null);
    }
  }

  return (
    <div>
      <header className="topbar">
        <strong>CROP</strong>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span style={{ color: "#9aa4b2", fontSize: 13 }}>
            {user?.role} · tenant {user?.tenantId.slice(0, 8)}
          </span>
          {canViewAudit && (
            <button className="btn secondary" onClick={() => navigate("/audit")}>
              Audit log
            </button>
          )}
          {canManageAdmin && (
            <>
              <button className="btn secondary" onClick={() => navigate("/admin/users")}>
                Manage users
              </button>
              <button className="btn secondary" onClick={() => navigate("/admin/equipment")}>
                Manage equipment
              </button>
            </>
          )}
          {canManagePlatform && (
            <button className="btn secondary" onClick={() => navigate("/superadmin/tenants")}>
              Manage tenants
            </button>
          )}
          <button className="btn secondary" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <main className="page">
        <h1>Equipment</h1>
        {error && (
          <p className="error" role="alert">
            {error}{" "}
            <button className="link-button" onClick={() => void load()}>
              Retry
            </button>
          </p>
        )}
        {loading ? (
          <p aria-live="polite">Loading...</p>
        ) : equipment.length === 0 ? (
          error ? null : <p style={{ color: "#9aa4b2" }}>No equipment registered for your tenant yet.</p>
        ) : (
          equipment.map((item) => {
            const activeSession = activeSessionFor(item.id);
            const nextPatient = item.queue.find((q) => q.status === "WAITING");
            return (
              <div className="card" key={item.id}>
                <div className="equipment-row" style={{ borderBottom: "none" }}>
                  <div>
                    <h2 style={{ display: "inline", fontSize: "1em", margin: 0 }}>{item.name}</h2>{" "}
                    <span className={`badge ${item.status.toLowerCase()}`}>{item.status}</span>
                    <div style={{ color: "#9aa4b2", fontSize: 13 }}>
                      {item.targetOs} · keymap {item.keymap} · {item.screenWidth}x{item.screenHeight}
                    </div>
                  </div>
                  {activeSession ? (
                    <button className="btn" onClick={() => navigate(`/sessions/${activeSession.id}`)}>
                      Rejoin session
                    </button>
                  ) : (
                    <button
                      className="btn"
                      disabled={item.status !== "ONLINE" || startingId === item.id}
                      title={item.status !== "ONLINE" ? `Equipment is ${item.status.toLowerCase()}, not reachable` : undefined}
                      onClick={() => startSession(item.id, nextPatient?.id)}
                    >
                      {startingId === item.id ? "Starting..." : "Start session"}
                    </button>
                  )}
                </div>

                <h3 style={{ marginBottom: 6, marginTop: 12, fontSize: "0.95em" }}>Patient queue</h3>
                {queueError && (
                  <p className="error" role="alert">
                    {queueError}
                  </p>
                )}
                {item.queue.length === 0 ? (
                  <p style={{ color: "#9aa4b2", fontSize: 13 }}>Empty.</p>
                ) : (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">#</th>
                          <th scope="col">Patient</th>
                          <th scope="col">Status</th>
                          <th scope="col">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {item.queue.map((q) => (
                          <tr key={q.id}>
                            <td>{q.position}</td>
                            <td>{q.patientFirstName}</td>
                            <td>{q.status}</td>
                            <td>
                              {q.status === "WAITING" && (
                                <button
                                  className="link-button"
                                  disabled={queueActionId === q.id}
                                  onClick={() => cancelQueueEntry(q.id)}
                                >
                                  Cancel
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <form onSubmit={(ev) => addPatient(item.id, ev)} style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <label className="visually-hidden" htmlFor={`add-patient-${item.id}`}>
                    Add a patient to {item.name}'s queue
                  </label>
                  <input
                    id={`add-patient-${item.id}`}
                    placeholder="Patient name"
                    value={newPatientName[item.id] ?? ""}
                    onChange={(e) => setNewPatientName((prev) => ({ ...prev, [item.id]: e.target.value }))}
                  />
                  <button className="btn secondary" type="submit" disabled={queueActionId === item.id}>
                    Add to queue
                  </button>
                </form>
              </div>
            );
          })
        )}
      </main>
    </div>
  );
}
