import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { AuditLogEntryDto, EquipmentDto, SessionSnapshotDto, SessionState } from "@crop/shared";
import { api } from "../lib/api-client.js";
import { useAuthenticatedImage } from "../hooks/use-authenticated-image.js";

const NEARBY_WINDOW_MS = 8000;

function summarizeAuditEntry(entry: AuditLogEntryDto): string {
  if (entry.action === "INPUT_BATCH") {
    const events = (entry.details as { events?: unknown[] })?.events ?? [];
    return `${events.length} input event(s)`;
  }
  if (entry.action === "PRINT_TEXT") {
    const details = entry.details as { length?: number };
    return `typed text (${details.length ?? "?"} chars)`;
  }
  return entry.action;
}

export default function SessionReplayPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();

  const [session, setSession] = useState<SessionState | null>(null);
  const [equipment, setEquipment] = useState<EquipmentDto | null>(null);
  const [snapshots, setSnapshots] = useState<SessionSnapshotDto[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntryDto[] | null>(null); // null = not authorized to view, not "empty"
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sessionId) return;
    void (async () => {
      const s = await api.get<SessionState>(`/sessions/${sessionId}`);
      const [eq, snaps] = await Promise.all([
        api.get<EquipmentDto>(`/equipment/${s.equipmentId}`),
        api.get<SessionSnapshotDto[]>(`/sessions/${sessionId}/snapshots`),
      ]);
      setSession(s);
      setEquipment(eq);
      setSnapshots(snaps);
      setIndex(Math.max(0, snaps.length - 1));

      // Only AUDITOR/SUPERVISOR/CLINIC_ADMIN/PLATFORM_ADMIN can list audit logs (see
      // AuditController's @Roles) -- an OPERATOR viewing their own session's replay simply
      // won't see this panel, which is the correct behaviour, not an error to surface.
      try {
        setAuditLogs(await api.get<AuditLogEntryDto[]>(`/audit?sessionId=${sessionId}&limit=500`));
      } catch {
        setAuditLogs(null);
      }
      setLoading(false);
    })();
  }, [sessionId]);

  const current = snapshots[index] ?? null;
  const imageUrl = useAuthenticatedImage(
    sessionId && current ? `/sessions/${sessionId}/snapshots/${current.id}/image` : null
  );

  const nearbyEvents = useMemo(() => {
    if (!auditLogs || !current) return [];
    const t = new Date(current.capturedAt).getTime();
    return auditLogs
      .filter((log) => Math.abs(new Date(log.timestamp).getTime() - t) <= NEARBY_WINDOW_MS)
      .filter((log) => log.action !== "SNAPSHOT_CAPTURED") // the snapshot itself, not interesting to list against itself
      .sort((a, b) => a.seq - b.seq);
  }, [auditLogs, current]);

  if (loading || !session || !equipment) return <div className="page">Loading replay...</div>;

  return (
    <div>
      <div className="topbar">
        <strong>{equipment.name} — Replay</strong>
        <button className="btn secondary" onClick={() => navigate(-1)}>
          Back
        </button>
      </div>

      <div className="page">
        {snapshots.length === 0 ? (
          <p style={{ color: "#9aa4b2" }}>
            No snapshots were captured for this session (it may have been too short, or ended before the first
            capture interval elapsed).
          </p>
        ) : (
          <div className="session-layout">
            <div>
              <div className="console-box">
                {imageUrl ? (
                  <img src={imageUrl} alt={`Console at ${current?.capturedAt}`} style={{ width: "100%", display: "block" }} />
                ) : (
                  <div style={{ aspectRatio: "16/9" }} />
                )}
                <div className="hud">{current ? new Date(current.capturedAt).toLocaleTimeString() : ""}</div>
              </div>

              <div className="card">
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, snapshots.length - 1)}
                  value={index}
                  onChange={(e) => setIndex(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#9aa4b2" }}>
                  <span>{new Date(snapshots[0]!.capturedAt).toLocaleTimeString()}</span>
                  <span>
                    Frame {index + 1} of {snapshots.length}
                  </span>
                  <span>{new Date(snapshots[snapshots.length - 1]!.capturedAt).toLocaleTimeString()}</span>
                </div>
              </div>
            </div>

            <div className="card">
              <h4 style={{ marginTop: 0 }}>
                Activity within {NEARBY_WINDOW_MS / 1000}s of this frame
              </h4>
              {auditLogs === null ? (
                <p style={{ fontSize: 13, color: "#9aa4b2" }}>
                  Your role does not have access to the audit trail. Snapshot playback is still available above.
                </p>
              ) : nearbyEvents.length === 0 ? (
                <p style={{ fontSize: 13, color: "#9aa4b2" }}>No recorded activity in this window.</p>
              ) : (
                <ul style={{ paddingLeft: 18, fontSize: 13 }}>
                  {nearbyEvents.map((entry) => (
                    <li key={entry.id}>
                      {new Date(entry.timestamp).toLocaleTimeString()} — {summarizeAuditEntry(entry)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
