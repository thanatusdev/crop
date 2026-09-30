import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Socket } from "socket.io-client";
import {
  RT_EVENTS,
  type ControllerChangedEvent,
  type EquipmentDto,
  type PatientPreparationUpdatedEvent,
  type QueueEntryDto,
  type SessionState,
} from "@crop/shared";
import { api } from "../lib/api-client.js";
import { useAuth } from "../lib/auth-context.js";
import { createSessionSocket } from "../lib/socket-client.js";
import { useMediaStream } from "../hooks/use-media-stream.js";
import { useHidInput } from "../hooks/use-hid-input.js";
import { useLatency } from "../hooks/use-latency.js";
import { CctvPip } from "../components/CctvPip.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";

export default function SessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [session, setSession] = useState<SessionState | null>(null);
  const [equipment, setEquipment] = useState<EquipmentDto | null>(null);
  const [preparation, setPreparation] = useState<QueueEntryDto | null>(null);
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
  // Mirrors TAKEOVER_ALLOWED_ROLES/RETURN_CONTROL_ALLOWED_ROLES.
  const isSupervisorEligible =
    user?.role === "OPERATIONAL_SUPERVISOR" ||
    user?.role === "CLINIC_ADMIN" ||
    user?.role === "OPERATOR_ADMIN" ||
    user?.role === "PLATFORM_ADMIN";
  const isOperatorInControl = session?.controllerUserId === session?.operatorId;
  // Mirrors Session.isParticipant() server-side: the operator, or a supervisor/admin who has
  // already taken over. A supervisor who merely opened this session to look (e.g. via
  // DashboardPage's "Rejoin session", shown for any active session regardless of viewer) is
  // NOT a participant until they actually take over -- EndSessionHandler rejects an "End
  // session" from them, so that button only renders once it would actually work. See
  // docs/architecture.md for the matching backend-side fix (SessionsGateway.onJoinSession).
  const isParticipant = session?.operatorId === user?.sub || session?.supervisorId === user?.sub;

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

  // A session started without a queue entry (equipment operated ad hoc, not from the
  // patient queue) has `queueEntryId: null` -- the panel below simply doesn't render then.
  useEffect(() => {
    if (!session?.queueEntryId) {
      setPreparation(null);
      return;
    }
    let cancelled = false;
    void api
      .get<QueueEntryDto>(`/queue/${session.queueEntryId}`)
      .then((entry) => {
        if (!cancelled) setPreparation(entry);
      })
      .catch(() => {
        // Non-fatal -- the panel just stays empty, same reasoning as ConsoleShell's health
        // pill: this is supplementary context for the Biomédico Operador, not something the
        // rest of the page depends on.
      });
    return () => {
      cancelled = true;
    };
  }, [session?.queueEntryId]);

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
    // Pushed by the nurse's "Ações Rápidas" quick-action buttons (see NursingPage) --
    // reflects this session's patient-preparation status live, with zero refetch, exactly
    // like CONTROLLER_CHANGED above. Only patches the fields the payload actually carries
    // (preparationStatus + the three timestamps) -- patientFirstName/position/status are
    // never in this payload (see PatientPreparationUpdatedEventSchema's own docstring) and
    // stay whatever the initial GET /queue/:id fetch set them to.
    sock.on(RT_EVENTS.PATIENT_PREPARATION_UPDATED, (payload: PatientPreparationUpdatedEvent) => {
      setPreparation((prev) => (prev && prev.id === payload.queueEntryId ? { ...prev, ...payload } : prev));
    });
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
      <main className="flex min-h-screen flex-col items-start gap-3 bg-background p-5 text-foreground">
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
        <Button variant="secondary" onClick={() => navigate("/")}>
          Back to dashboard
        </Button>
      </main>
    );
  }

  if (!session || !equipment) {
    return (
      <main className="min-h-screen bg-background p-5 text-foreground" aria-live="polite">
        Loading session...
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-5 py-3.5">
        <strong>{equipment.name}</strong>
        <div className="flex gap-3">
          {isSupervisorEligible && !isController && (
            <Button variant="secondary" onClick={requestTakeover}>
              Take over
            </Button>
          )}
          {isSupervisorEligible && !isOperatorInControl && (
            <Button variant="secondary" onClick={requestReturnControl}>
              Return control to operator
            </Button>
          )}
          <Button variant="secondary" onClick={() => navigate(`/sessions/${sessionId}/replay`)}>
            View replay
          </Button>
          {isParticipant && (
            <Button variant="destructive" onClick={endSession} disabled={ending}>
              {ending ? "Ending..." : "End session"}
            </Button>
          )}
        </div>
      </header>

      <main className="p-5">
        <h1 className="sr-only">{equipment.name} session</h1>
        {actionError && (
          <Alert variant="destructive" className="mb-3">
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        )}
        {!isController && (
          <div className="mb-3 rounded-md bg-destructive px-4 py-2.5 font-semibold text-white" role="status">
            You are not in control of this session. Input is disabled.
          </div>
        )}

        <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,1fr)] items-start gap-4">
          {/* `tabIndex={0}` + capturing keydown/keyup (see useHidInput) means every key
              pressed while this box has focus -- including Tab and Escape -- is sent to the
              remote equipment instead of being used for browser focus navigation. This is an
              inherent limitation shared by every browser-based remote-KVM/VNC/RDP client, not
              an oversight: the remote OS needs Tab to move between ITS fields too. A keyboard
              user can still leave via Shift+Tab from outside this box, or by clicking any
              other control.

              This box (and the `.hud`/`CctvPip` overlays inside it) stays black regardless of
              the app's own theme -- a real video surface, not page chrome, so it keeps its own
              self-contained colors exactly like a `Badge` does, per the "shared ancestor" rule
              (see docs/architecture.md). The canvas itself keeps `w-full block` and no other
              sizing utility: `useHidInput`'s own mouse-coordinate math assumes its CSS box
              always matches its intrinsic aspect ratio with zero letterboxing (`width: 100%,
              height: auto`) -- adding `object-fit`/a fixed height/an aspect-ratio wrapper here
              would silently break every click position sent to the equipment. The overlays
              are `pointer-events-none` -- a real click landing in their corner (top-left here,
              `CctvPip`'s own bottom-right) needs to reach the canvas underneath, not the
              decorative HUD text sitting on top of it; the pre-Tailwind `.hud` never set this
              either, a latent "click swallowed by the corner readout" gap fixed alongside this
              migration rather than carried over unnoticed. */}
          <div
            className="relative overflow-hidden rounded-lg bg-black focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-primary focus-visible:outline-offset-2"
            ref={containerRef}
            tabIndex={0}
            role="group"
            aria-label={`${equipment.name} remote console. When focused, keyboard and mouse input is sent directly to the equipment.`}
          >
            <canvas ref={canvasRef} role="img" aria-label={`Live video of ${equipment.name}`} className="block w-full" />
            <div
              className="pointer-events-none absolute top-2 left-2 rounded-md bg-black/60 px-2.5 py-1.5 font-mono text-xs text-white"
              aria-hidden="true"
            >
              <div>stream: {streamState.status}</div>
              <div>input RTT: {rttMs !== null ? `${rttMs} ms` : "—"}</div>
            </div>
            <CctvPip whepUrl={equipment.cameraUrl} />
            {streamState.status === "error" && (
              <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-black/60 px-2.5 py-1.5 font-mono text-xs text-white" role="alert">
                {streamState.info}
              </div>
            )}
          </div>

          <div>
            <Card className="mb-4">
              <CardHeader>
                <CardTitle className="text-[1.1em]">Session</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p className="text-[13px] text-muted-foreground">
                  Operator: {session.operatorName ?? session.operatorId.slice(0, 8)}
                  <br />
                  Supervisor: {session.supervisorId ? session.supervisorId.slice(0, 8) : "—"}
                  <br />
                  Controller: {session.controllerUserId.slice(0, 8)}
                </p>
                <Button variant="secondary" onClick={emergencyReleaseAll} disabled={releasing} className="w-full">
                  {releasing ? "Releasing..." : "Emergency release (unstick keys)"}
                </Button>
              </CardContent>
            </Card>

            {preparation && (
              <Card className="mb-4">
                <CardHeader>
                  <CardTitle className="text-[1.1em]">Patient preparation</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-[13px] text-muted-foreground" aria-live="polite">
                    Status: {preparation.preparationStatus}
                    <br />
                    Positioned: {preparation.positionedAt ? new Date(preparation.positionedAt).toLocaleTimeString() : "—"}
                    <br />
                    Injected: {preparation.injectedAt ? new Date(preparation.injectedAt).toLocaleTimeString() : "—"}
                    <br />
                    Released: {preparation.releasedAt ? new Date(preparation.releasedAt).toLocaleTimeString() : "—"}
                  </p>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-[1.1em]" id="type-text-heading">
                  Type text
                </CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={submitPrintText}>
                  <div className="mb-3.5 flex flex-col gap-1.5">
                    <Label htmlFor="session-print-text" className="sr-only">
                      Text to type into the remote equipment
                    </Label>
                    <Input
                      id="session-print-text"
                      aria-describedby="type-text-heading"
                      value={printText}
                      onChange={(e) => setPrintText(e.target.value)}
                      disabled={!isController}
                      placeholder="Patient ID, name..."
                    />
                  </div>
                  <Button type="submit" disabled={!isController || !printText}>
                    Send
                  </Button>
                  {printSent && (
                    <p role="status" className="mt-2 text-[13px] text-[#166534]">
                      ✓ Sent to equipment
                    </p>
                  )}
                </form>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
