import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Socket } from "socket.io-client";
import { RT_EVENTS, type ControllerChangedEvent, type EquipmentDto, type SessionState } from "@crop/shared";
import { api } from "../lib/api-client.js";
import { useAuth } from "../lib/auth-context.js";
import { createSessionSocket } from "../lib/socket-client.js";
import { useMediaStream } from "../hooks/use-media-stream.js";
import { useHidInput } from "../hooks/use-hid-input.js";
import { useLatency } from "../hooks/use-latency.js";
import { CctvPip } from "../components/CctvPip.js";

export default function SessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [session, setSession] = useState<SessionState | null>(null);
  const [equipment, setEquipment] = useState<EquipmentDto | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [printText, setPrintText] = useState("");
  const [ending, setEnding] = useState(false);
  const [releasing, setReleasing] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const isController = session?.controllerUserId === user?.sub;
  const isSupervisorEligible = user?.role === "SUPERVISOR" || user?.role === "CLINIC_ADMIN" || user?.role === "PLATFORM_ADMIN";

  useEffect(() => {
    if (!sessionId) return;
    void api.get<SessionState>(`/sessions/${sessionId}`).then(async (s) => {
      setSession(s);
      setEquipment(await api.get<EquipmentDto>(`/equipment/${s.equipmentId}`));
    });
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const sock = createSessionSocket();
    sock.connect();
    sock.on("connect", () => sock.emit(RT_EVENTS.JOIN_SESSION, { sessionId }));
    sock.on(RT_EVENTS.CONTROLLER_CHANGED, (payload: ControllerChangedEvent) => {
      setSession((prev) => (prev ? { ...prev, controllerUserId: payload.controllerUserId } : prev));
    });
    sock.on(RT_EVENTS.SESSION_STATE, (payload: SessionState) => setSession(payload));
    sock.on(RT_EVENTS.SESSION_ENDED, () => navigate("/"));
    setSocket(sock);
    return () => {
      sock.disconnect();
    };
  }, [sessionId, navigate]);

  const streamState = useMediaStream(sessionId ?? "", canvasRef);
  useHidInput({ socket, canvasRef, containerRef, enabled: isController });
  const rttMs = useLatency(socket);

  const requestTakeover = useCallback(() => {
    socket?.emit(RT_EVENTS.TAKEOVER_REQUEST, { sessionId });
  }, [socket, sessionId]);

  const submitPrintText = useCallback(
    (ev: React.FormEvent) => {
      ev.preventDefault();
      socket?.emit(RT_EVENTS.PRINT_TEXT, { text: printText });
      setPrintText("");
    },
    [socket, printText]
  );

  async function endSession() {
    if (!sessionId) return;
    setEnding(true);
    try {
      await api.post(`/sessions/${sessionId}/end`);
      navigate("/");
    } finally {
      setEnding(false);
    }
  }

  async function emergencyReleaseAll() {
    if (!sessionId) return;
    setReleasing(true);
    try {
      await api.post(`/sessions/${sessionId}/release-all`);
    } finally {
      setReleasing(false);
    }
  }

  if (!session || !equipment) return <div className="page">Loading session...</div>;

  return (
    <div>
      <div className="topbar">
        <strong>{equipment.name}</strong>
        <div style={{ display: "flex", gap: 12 }}>
          {isSupervisorEligible && !isController && (
            <button className="btn secondary" onClick={requestTakeover}>
              Take over
            </button>
          )}
          <button className="btn secondary" onClick={() => navigate(`/sessions/${sessionId}/replay`)}>
            View replay
          </button>
          <button className="btn danger" onClick={endSession} disabled={ending}>
            {ending ? "Ending..." : "End session"}
          </button>
        </div>
      </div>

      <div className="page">
        {!isController && (
          <div className="takeover-banner">
            You are not in control of this session. Input is disabled.
          </div>
        )}

        <div className="session-layout">
          <div className="console-box" ref={containerRef} tabIndex={0}>
            <canvas ref={canvasRef} />
            <div className="hud">
              <div>stream: {streamState.status}</div>
              <div>input RTT: {rttMs !== null ? `${rttMs} ms` : "—"}</div>
            </div>
            <CctvPip whepUrl={equipment.cameraUrl} />
            {streamState.status === "error" && (
              <div className="hud" style={{ top: "auto", bottom: 8 }}>
                {streamState.info}
              </div>
            )}
          </div>

          <div>
            <div className="card">
              <h4 style={{ marginTop: 0 }}>Session</h4>
              <p style={{ fontSize: 13, color: "#9aa4b2" }}>
                Operator: {session.operatorId.slice(0, 8)}
                <br />
                Supervisor: {session.supervisorId ? session.supervisorId.slice(0, 8) : "—"}
                <br />
                Controller: {session.controllerUserId.slice(0, 8)}
              </p>
              <button className="btn secondary" onClick={emergencyReleaseAll} disabled={releasing} style={{ width: "100%" }}>
                {releasing ? "Releasing..." : "Emergency release (unstick keys)"}
              </button>
            </div>

            <div className="card">
              <h4 style={{ marginTop: 0 }}>Type text</h4>
              <form onSubmit={submitPrintText}>
                <div className="field">
                  <input
                    value={printText}
                    onChange={(e) => setPrintText(e.target.value)}
                    disabled={!isController}
                    placeholder="Patient ID, name..."
                  />
                </div>
                <button className="btn" type="submit" disabled={!isController || !printText}>
                  Send
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
