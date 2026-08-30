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
      <div className="topbar">
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
      </div>

      <div className="page">
        <h2>Equipment</h2>
        {error && <p className="error">{error}</p>}
        {loading ? (
          <p>Loading...</p>
        ) : equipment.length === 0 ? (
          <p style={{ color: "#9aa4b2" }}>No equipment registered for your tenant yet.</p>
        ) : (
          equipment.map((item) => {
            const activeSession = activeSessionFor(item.id);
            const nextPatient = item.queue.find((q) => q.status === "WAITING");
            return (
              <div className="card" key={item.id}>
                <div className="equipment-row" style={{ borderBottom: "none" }}>
                  <div>
                    <strong>{item.name}</strong>{" "}
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
                      onClick={() => startSession(item.id, nextPatient?.id)}
                    >
                      {startingId === item.id ? "Starting..." : "Start session"}
                    </button>
                  )}
                </div>

                <h4 style={{ marginBottom: 6, marginTop: 12 }}>Patient queue</h4>
                {item.queue.length === 0 ? (
                  <p style={{ color: "#9aa4b2", fontSize: 13 }}>Empty.</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Patient</th>
                        <th>Status</th>
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
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
