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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [printText, setPrintText] = useState("");
  const [printSent, setPrintSent] = useState(false);
  const [ending, setEnding] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const printSentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isController = session?.controllerUserId === user?.sub;
  const isSupervisorEligible = user?.role === "SUPERVISOR" || user?.role === "CLINIC_ADMIN" || user?.role === "PLATFORM_ADMIN";
  const isOperatorInControl = session?.controllerUserId === session?.operatorId;

  useEffect(() => {
    if (!sessionId) return;
    setLoadError(null);
    void api
      .get<SessionState>(`/sessions/${sessionId}`)
      .then(async (s) => {
        setSession(s);
        setEquipment(await api.get<EquipmentDto>(`/equipment/${s.equipmentId}`));
      })
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : "Could not load this session.");
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

  // Only a SUPERVISOR/*_ADMIN may trigger this, mirroring takeover -- the operator can never
  // reclaim their own session unilaterally, and any eligible role (not only whoever took
  // over) can decide it's safe to hand back. See ReturnControlToOperatorHandler.
  const requestReturnControl = useCallback(() => {
    socket?.emit(RT_EVENTS.RETURN_CONTROL_REQUEST, { sessionId });
  }, [socket, sessionId]);

  const submitPrintText = useCallback(
    (ev: React.FormEvent) => {
      ev.preventDefault();
      socket?.emit(RT_EVENTS.PRINT_TEXT, { text: printText });
      setPrintText("");
      // The socket emit above is fire-and-forget -- there's no ack, and the actual
      // PRINT_TEXT audit row (the real confirmation) only lands after a round trip to the
      // device. This is a best-effort "your click registered" signal, not proof of
      // delivery: without it, clearing the field on submit with zero other feedback looked
      // indistinguishable from the click having done nothing at all.
      setPrintSent(true);
      if (printSentTimerRef.current) clearTimeout(printSentTimerRef.current);
      printSentTimerRef.current = setTimeout(() => setPrintSent(false), 2500);
    },
    [socket, printText]
  );

  useEffect(() => {
    return () => {
      if (printSentTimerRef.current) clearTimeout(printSentTimerRef.current);
    };
  }, []);

  async function endSession() {
    if (!sessionId) return;
    setActionError(null);
    setEnding(true);
    try {
      await api.post(`/sessions/${sessionId}/end`);
      navigate("/");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not end the session.");
    } finally {
      setEnding(false);
    }
  }

  async function emergencyReleaseAll() {
    if (!sessionId) return;
    setActionError(null);
    setReleasing(true);
    try {
      await api.post(`/sessions/${sessionId}/release-all`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not release input. Try again.");
    } finally {
      setReleasing(false);
    }
  }

  if (loadError) {
    return (
      <main className="page">
        <p className="error" role="alert">
          {loadError}
        </p>
        <button className="btn secondary" onClick={() => navigate("/")}>
          Back to dashboard
        </button>
      </main>
    );
  }

  if (!session || !equipment) {
    return (
      <main className="page" aria-live="polite">
        Loading session...
      </main>
    );
  }

  return (
    <div>
      <header className="topbar">
        <strong>{equipment.name}</strong>
        <div style={{ display: "flex", gap: 12 }}>
          {isSupervisorEligible && !isController && (
            <button className="btn secondary" onClick={requestTakeover}>
              Take over
            </button>
          )}
          {isSupervisorEligible && !isOperatorInControl && (
            <button className="btn secondary" onClick={requestReturnControl}>
              Return control to operator
            </button>
          )}
          <button className="btn secondary" onClick={() => navigate(`/sessions/${sessionId}/replay`)}>
            View replay
          </button>
          <button className="btn danger" onClick={endSession} disabled={ending}>
            {ending ? "Ending..." : "End session"}
          </button>
        </div>
      </header>

      <main className="page">
        <h1 className="visually-hidden">{equipment.name} session</h1>
        {actionError && (
          <p className="error" role="alert">
            {actionError}
          </p>
        )}
        {!isController && (
          <div className="takeover-banner" role="status">
            You are not in control of this session. Input is disabled.
          </div>
        )}

        <div className="session-layout">
          {/* `tabIndex={0}` + capturing keydown/keyup (see useHidInput) means every key
              pressed while this box has focus -- including Tab and Escape -- is sent to the
              remote equipment instead of being used for browser focus navigation. This is an
              inherent limitation shared by every browser-based remote-KVM/VNC/RDP client, not
              an oversight: the remote OS needs Tab to move between ITS fields too. A keyboard
              user can still leave via Shift+Tab from outside this box, or by clicking any
              other control. */}
          <div
            className="console-box"
            ref={containerRef}
            tabIndex={0}
            role="group"
            aria-label={`${equipment.name} remote console. When focused, keyboard and mouse input is sent directly to the equipment.`}
          >
            <canvas ref={canvasRef} role="img" aria-label={`Live video of ${equipment.name}`} />
            <div className="hud" aria-hidden="true">
              <div>stream: {streamState.status}</div>
              <div>input RTT: {rttMs !== null ? `${rttMs} ms` : "—"}</div>
            </div>
            <CctvPip whepUrl={equipment.cameraUrl} />
            {streamState.status === "error" && (
              <div className="hud" role="alert" style={{ top: "auto", bottom: 8 }}>
                {streamState.info}
              </div>
            )}
          </div>

          <div>
            <div className="card">
              <h2 style={{ marginTop: 0, fontSize: "1.1em" }}>Session</h2>
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
              <h2 style={{ marginTop: 0, fontSize: "1.1em" }} id="type-text-heading">
                Type text
              </h2>
              <form onSubmit={submitPrintText}>
                <div className="field">
                  <label htmlFor="session-print-text" className="visually-hidden">
                    Text to type into the remote equipment
                  </label>
                  <input
                    id="session-print-text"
                    aria-describedby="type-text-heading"
                    value={printText}
                    onChange={(e) => setPrintText(e.target.value)}
                    disabled={!isController}
                    placeholder="Patient ID, name..."
                  />
                </div>
                <button className="btn" type="submit" disabled={!isController || !printText}>
                  Send
                </button>
                {printSent && (
                  <p role="status" style={{ color: "#5fdc8a", fontSize: 13, marginTop: 8, marginBottom: 0 }}>
                    ✓ Sent to equipment
                  </p>
                )}
              </form>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
