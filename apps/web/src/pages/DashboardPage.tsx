import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { EquipmentDto, QueueEntryDto, SessionState } from "@crop/shared";
import { api } from "../lib/api-client.js";
import { useAuth } from "../lib/auth-context.js";

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

  // Mirrors AuditController's @Roles -- avoids sending an OPERATOR into a guaranteed 403.
  const canViewAudit =
    user?.role === "AUDITOR" || user?.role === "SUPERVISOR" || user?.role === "CLINIC_ADMIN" || user?.role === "PLATFORM_ADMIN";

  useEffect(() => {
    void load();
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
                        </tr>
                      </thead>
                      <tbody>
                        {item.queue.map((q) => (
                          <tr key={q.id}>
                            <td>{q.position}</td>
                            <td>{q.patientFirstName}</td>
                            <td>{q.status}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })
        )}
      </main>
    </div>
  );
}
