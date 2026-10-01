import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { Socket } from "socket.io-client";
import {
  AllergyStatus,
  RT_EVENTS,
  todayClinicDayString,
  type ControllerChangedEvent,
  type EquipmentDto,
  type ExamMessageDto,
  type MessageShortcutDto,
  type PatientPreparationUpdatedEvent,
  type QueueEntryDto,
  type SessionState,
  type UnitDto,
} from "@crop/shared";
import { api, ApiError } from "../lib/api-client.js";
import { useAuth } from "../lib/auth-context.js";
import { createSessionSocket } from "../lib/socket-client.js";
import { useMediaStream } from "../hooks/use-media-stream.js";
import { useHidInput } from "../hooks/use-hid-input.js";
import { useLatency } from "../hooks/use-latency.js";
import { RoomCameraPanel } from "../components/RoomCameraPanel.js";
import { QueueStrip } from "../components/QueueStrip.js";
import { ExamChat } from "../components/ExamChat.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Textarea } from "../components/ui/textarea.js";
import { Badge } from "../components/ui/badge.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { cn } from "cn";
import { Download, FileText, ShieldAlert, ShieldCheck } from "lucide-react";
import { MODALITY_ABBREVIATION } from "../lib/equipment-display.js";
import { humanFileSize } from "../lib/file-display.js";
import {
  allergyStatusLabelKeyOf,
  currentPatientOf,
  isDetailsEditable,
  patientSexLabelKeyOf,
  preparationStatusBadgeClass,
  preparationStatusLabelKeyOf,
} from "../lib/queue-display.js";

/**
 * The remote operator's cockpit: one equipment, one screen. Rebuilt from the RadLink
 * Teleoperação mock's own layout -- a top queue rail, the room camera and its chat on the
 * left, the live PiKVM console mirror occupying the whole centre column, and the active
 * patient's record plus every action button on the right. Reached from `WorkstationPage`'s
 * "Confirmar e Acessar Sala" (`?equipmentId=`) once the shift's room is picked.
 *
 * `/sessions/:sessionId` (`SessionPage`) is not removed or redirected by this -- it stays the
 * generic per-session console any authenticated participant/supervisor can reach by session
 * id (e.g. from `DashboardPage`'s "Rejoin session"). This page is `?equipmentId=`-scoped
 * instead, on purpose: the operator's own workflow is "this room, whichever exam is running
 * or about to," not "this one session id" -- when a session ends, the page reverts to its own
 * "start the next exam" prompt for the same room.
 *
 * The exam-support chat (`ExamChat`, shared with `NursingPage`) is equipment-scoped, not
 * session-scoped -- it connects and stays usable whether or not an exam is currently running,
 * which is why this page's socket lifecycle no longer waits for a session to exist at all
 * (see the two separate connection effects below: one for the room's chat, always live; one
 * for the session's own control-plane events, only while a session exists).
 *
 * Not reproduced from the source mock, for the same "no fabricated telemetry" policy every
 * prior pass has held to: parsed/native scanner protocol integration (kV/mA readouts, a
 * "Scan em Andamento" progress bar, DICOM/PACS viewport panes) -- the centre column is
 * reserved for the one real link to the equipment, the console mirror, exactly as on
 * `SessionPage`; "Intercorrência"/room-safety sensor panels -- same reasoning `NursingPage`'s
 * own docstring already gives for the identical mock elements there. The push-to-talk
 * intercom this page used to render (`IntercomChannel`, presence-only, no audio ever rode on
 * it) was removed outright, not merely hidden -- see that feature's own removal note on
 * `AuditAction.INTERCOM_PTT`.
 */
export default function ExamPage() {
  const { t } = useTranslation(["exam", "nursing"]);
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const equipmentId = params.get("equipmentId") ?? "";
  const today = useMemo(() => todayClinicDayString(), []);

  const [equipment, setEquipment] = useState<EquipmentDto | null>(null);
  const [unit, setUnit] = useState<UnitDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueEntryDto[]>([]);

  const [session, setSession] = useState<SessionState | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const [socket, setSocket] = useState<Socket | null>(null);
  const [ending, setEnding] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [printText, setPrintText] = useState("");
  const [printSent, setPrintSent] = useState(false);
  const printSentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [messages, setMessages] = useState<ExamMessageDto[]>([]);
  const [chatDay, setChatDay] = useState(today);
  const [chatLoadError, setChatLoadError] = useState<string | null>(null);
  const [shortcuts, setShortcuts] = useState<MessageShortcutDto[]>([]);
  const [creatingShortcut, setCreatingShortcut] = useState(false);
  const [createShortcutError, setCreateShortcutError] = useState<string | null>(null);

  const [selectedQueueEntryId, setSelectedQueueEntryId] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState("");
  const [notesSaving, setNotesSaving] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const isController = session?.controllerUserId === user?.sub;
  const isSupervisorEligible =
    user?.role === "OPERATIONAL_SUPERVISOR" ||
    user?.role === "CLINIC_ADMIN" ||
    user?.role === "OPERATOR_ADMIN" ||
    user?.role === "PLATFORM_ADMIN";
  const isOperatorInControl = session?.controllerUserId === session?.operatorId;
  const isParticipant = session?.operatorId === user?.sub || session?.supervisorId === user?.sub;

  const loadEquipmentAndQueue = useCallback(async () => {
    if (!equipmentId) return;
    setLoadError(null);
    try {
      const item = await api.get<EquipmentDto>(`/equipment/${equipmentId}`);
      setEquipment(item);
      if (item.unitId) {
        const units = await api.get<UnitDto[]>("/units");
        setUnit(units.find((u) => u.id === item.unitId) ?? null);
      }
      setQueue(await api.get<QueueEntryDto[]>(`/queue?equipmentId=${equipmentId}&date=${today}`));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("exam:loadError"));
    }
  }, [equipmentId, today, t]);

  useEffect(() => {
    void loadEquipmentAndQueue();
  }, [loadEquipmentAndQueue]);

  // Whether this room already has an exam running -- if so, join it rather than showing the
  // "start the next exam" prompt. Re-checked whenever the room's own queue is reloaded (e.g.
  // after SESSION_ENDED below reverts this page to the prompt for the *next* patient), and
  // whenever the caller's active tenant changes -- `/sessions/active` is scoped by it
  // server-side, same reasoning as ConsoleShell's own staleness fix.
  useEffect(() => {
    if (!equipmentId) return;
    let cancelled = false;
    void api
      .get<SessionState[]>("/sessions/active")
      .then((sessions) => {
        if (!cancelled) setSession(sessions.find((s) => s.equipmentId === equipmentId) ?? null);
      })
      .catch(() => {
        // Best-effort -- the "start exam" prompt is still a safe fallback if this fails.
      });
    return () => {
      cancelled = true;
    };
  }, [equipmentId, user?.tenantId]);

  async function startExam() {
    if (!equipmentId) return;
    setStartError(null);
    setStarting(true);
    try {
      const nextPatient = currentPatientOf(queue);
      const started = await api.post<SessionState>("/sessions", { equipmentId, queueEntryId: nextPatient?.id });
      setSession(started);
    } catch (err) {
      setStartError(err instanceof ApiError ? err.message : t("exam:startError"));
    } finally {
      setStarting(false);
    }
  }

  // The room's own chat/queue-status socket -- connects as soon as a room is picked,
  // independent of whether an exam session exists yet (see this page's own docstring on why
  // that changed). Joins the equipment's chat room immediately, and separately joins the
  // tenant room every socket auto-joins server-side (see SessionsGateway.handleConnection),
  // which is what QUEUE_UPDATED/PATIENT_PREPARATION_UPDATED ride on regardless of session.
  useEffect(() => {
    if (!equipmentId) {
      setSocket(null);
      return;
    }
    const sock = createSessionSocket();
    sock.connect();
    sock.on("connect", () => sock.emit(RT_EVENTS.JOIN_EQUIPMENT_CHAT, { equipmentId }));
    sock.on(RT_EVENTS.EXAM_MESSAGE_CREATED, (payload: ExamMessageDto) => {
      // A day-scoped transcript only ever shows *today's* live arrivals as they happen --
      // appending a message for a different day the panel isn't currently showing would
      // silently grow a list the operator can't see grow, then reorder the world once they
      // paged back to today. Filtered by `chatDay` at append time, not at render time, so
      // switching days doesn't need to re-filter a mixed-day array.
      setMessages((prev) => (payload.createdAt.slice(0, 10) === chatDay ? [...prev, payload] : prev));
    });
    sock.on(RT_EVENTS.QUEUE_UPDATED, (payload: { equipmentId: string }) => {
      if (payload.equipmentId === equipmentId) void loadEquipmentAndQueue();
    });
    sock.on(RT_EVENTS.PATIENT_PREPARATION_UPDATED, (payload: PatientPreparationUpdatedEvent) => {
      if (payload.equipmentId === equipmentId) void loadEquipmentAndQueue();
    });
    setSocket(sock);
    return () => {
      sock.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equipmentId]);

  // The session's own control-plane events -- layered onto the same socket above, attached
  // and detached as sessions start and end, rather than reconnecting the whole socket (which
  // would also drop it out of the equipment chat room for no reason).
  useEffect(() => {
    if (!socket || !session?.id) return;
    const sessionId = session.id;
    socket.emit(RT_EVENTS.JOIN_SESSION, { sessionId });

    const onControllerChanged = (payload: ControllerChangedEvent) => {
      setSession((prev) => (prev ? { ...prev, controllerUserId: payload.controllerUserId } : prev));
    };
    const onSessionState = (payload: SessionState) => setSession(payload);
    // The exam this room was running just ended -- revert to the "start the next exam"
    // prompt for the same room, rather than navigating away: see this page's own docstring
    // on why staying put on the room is the whole point of being equipment-scoped. The chat
    // transcript is deliberately NOT cleared here anymore -- it belongs to the room, not to
    // the session that just ended (see `ExamMessageSchema`'s own docstring).
    const onSessionEnded = () => {
      setSession(null);
      void loadEquipmentAndQueue();
    };

    socket.on(RT_EVENTS.CONTROLLER_CHANGED, onControllerChanged);
    socket.on(RT_EVENTS.SESSION_STATE, onSessionState);
    socket.on(RT_EVENTS.SESSION_ENDED, onSessionEnded);
    return () => {
      socket.off(RT_EVENTS.CONTROLLER_CHANGED, onControllerChanged);
      socket.off(RT_EVENTS.SESSION_STATE, onSessionState);
      socket.off(RT_EVENTS.SESSION_ENDED, onSessionEnded);
    };
  }, [socket, session?.id, loadEquipmentAndQueue]);

  const streamState = useMediaStream(session?.id ?? null, canvasRef);
  useHidInput({ socket, canvasRef, containerRef, enabled: isController });
  const rttMs = useLatency(socket);

  // The chat transcript is reloaded whenever the room or the shown day changes -- see
  // `ChatController`'s own `date` query param. Shortcuts don't vary by day; refetching them
  // alongside is harmless and keeps this a single effect rather than two nearly-identical
  // ones.
  useEffect(() => {
    if (!equipmentId) return;
    let cancelled = false;
    setChatLoadError(null);
    void Promise.all([
      api.get<ExamMessageDto[]>(`/chat/messages?equipmentId=${equipmentId}&date=${chatDay}`),
      api.get<MessageShortcutDto[]>("/chat/shortcuts"),
    ])
      .then(([messageList, shortcutList]) => {
        if (cancelled) return;
        setMessages(messageList);
        setShortcuts(shortcutList);
      })
      .catch((err) => {
        if (!cancelled) setChatLoadError(err instanceof Error ? err.message : t("exam:chatLoadError"));
      });
    return () => {
      cancelled = true;
    };
  }, [equipmentId, chatDay, t]);

  async function sendChatMessage(body: string, file: File | null) {
    const form = new FormData();
    form.append("equipmentId", equipmentId);
    form.append("body", body);
    if (file) form.append("file", file);
    await api.postForm(`/chat/messages`, form);
  }

  async function createShortcut(input: { code: string; label: string; body: string }) {
    setCreatingShortcut(true);
    setCreateShortcutError(null);
    try {
      const created = await api.post<MessageShortcutDto>("/chat/shortcuts", input);
      setShortcuts((prev) => [...prev, created]);
    } catch (err) {
      setCreateShortcutError(err instanceof ApiError ? err.message : t("exam:shortcutError"));
      throw err;
    } finally {
      setCreatingShortcut(false);
    }
  }

  const requestTakeover = useCallback(() => {
    socket?.emit(RT_EVENTS.TAKEOVER_REQUEST, { sessionId: session?.id });
  }, [socket, session?.id]);

  const requestReturnControl = useCallback(() => {
    socket?.emit(RT_EVENTS.RETURN_CONTROL_REQUEST, { sessionId: session?.id });
  }, [socket, session?.id]);

  const submitPrintText = useCallback(
    (ev: React.FormEvent) => {
      ev.preventDefault();
      socket?.emit(RT_EVENTS.PRINT_TEXT, { text: printText });
      setPrintText("");
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
    if (!session?.id) return;
    setActionError(null);
    setEnding(true);
    try {
      await api.post(`/sessions/${session.id}/end`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("exam:endError"));
    } finally {
      setEnding(false);
    }
  }

  async function emergencyReleaseAll() {
    if (!session?.id) return;
    setActionError(null);
    setReleasing(true);
    try {
      await api.post(`/sessions/${session.id}/release-all`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("exam:releaseError"));
    } finally {
      setReleasing(false);
    }
  }

  // ------------------------------------------------------------------------------------
  // Active-patient panel (right column) -- inline now, not a modal: defaults to the room's
  // current patient (`currentPatientOf`, the same IN_PROGRESS-else-next-WAITING precedence
  // the "start exam" prompt above already uses) and only ever changes when someone actually
  // selects a different card from the top queue rail. PHI minimization unchanged: only
  // fields this platform actually stores, same as every nursing screen.
  // ------------------------------------------------------------------------------------

  const selectedEntry = queue.find((entry) => entry.id === selectedQueueEntryId) ?? null;

  function selectPatient(entry: QueueEntryDto) {
    setSelectedQueueEntryId(entry.id);
    setNotesDraft(entry.teleoperationNotes ?? "");
    setNotesError(null);
  }

  useEffect(() => {
    if (selectedQueueEntryId) return;
    const next = currentPatientOf(queue);
    if (next) selectPatient(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, selectedQueueEntryId]);

  // Mirrors QueueEntry.assertTeleoperationNotesEditable in apps/api exactly (WAITING or
  // IN_PROGRESS) -- the identical rule isDetailsEditable already expresses for the nurse's
  // own fields, reused rather than re-declared for a second time in this file.
  const notesEditable = !!selectedEntry && isDetailsEditable(selectedEntry);

  async function saveTeleoperationNotes() {
    if (!selectedEntry) return;
    setNotesSaving(true);
    setNotesError(null);
    try {
      await api.patch(`/queue/${selectedEntry.id}/teleoperation-notes`, { teleoperationNotes: notesDraft });
      setQueue((prev) => prev.map((entry) => (entry.id === selectedEntry.id ? { ...entry, teleoperationNotes: notesDraft } : entry)));
    } catch (err) {
      setNotesError(err instanceof ApiError ? err.message : t("exam:notesError"));
    } finally {
      setNotesSaving(false);
    }
  }

  // ------------------------------------------------------------------------------------

  if (!equipmentId) {
    return (
      <main className="flex min-h-screen flex-col items-start gap-3 bg-background p-5 text-foreground">
        <Alert variant="destructive">
          <AlertDescription>{t("exam:noEquipmentSelected")}</AlertDescription>
        </Alert>
        <Button variant="secondary" onClick={() => navigate("/posto-de-trabalho")}>
          {t("exam:backToWorkstation")}
        </Button>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="flex min-h-screen flex-col items-start gap-3 bg-background p-5 text-foreground">
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
        <Button variant="secondary" onClick={() => navigate("/posto-de-trabalho")}>
          {t("exam:backToWorkstation")}
        </Button>
      </main>
    );
  }

  if (!equipment) {
    return (
      <main className="min-h-screen bg-background p-5 text-foreground" aria-live="polite">
        {t("exam:loading")}
      </main>
    );
  }

  const roomHeading = equipment.roomLabel ?? equipment.name;
  const roomSubtitle = [equipment.modality ? MODALITY_ABBREVIATION[equipment.modality] : null, unit?.name ?? null]
    .filter((part): part is string => !!part)
    .join(" · ");

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-5 py-3.5">
        <div>
          <strong>{roomHeading}</strong>
          {roomSubtitle && <span className="ml-2 text-[13px] text-muted-foreground">{roomSubtitle}</span>}
        </div>
        {session && (
          <div className="flex gap-3">
            {isSupervisorEligible && !isController && (
              <Button variant="secondary" onClick={requestTakeover}>
                {t("exam:takeOver")}
              </Button>
            )}
            {isSupervisorEligible && !isOperatorInControl && (
              <Button variant="secondary" onClick={requestReturnControl}>
                {t("exam:returnControl")}
              </Button>
            )}
            <Button variant="secondary" onClick={() => navigate(`/sessions/${session.id}/replay`)}>
              {t("exam:viewReplay")}
            </Button>
            {isParticipant && (
              <Button variant="destructive" onClick={endSession} disabled={ending}>
                {ending ? t("exam:ending") : t("exam:endExam")}
              </Button>
            )}
          </div>
        )}
      </header>

      <main className="mx-auto max-w-[1600px] p-5">
        <h1 className="sr-only">{t("exam:heading", { room: roomHeading })}</h1>
        {actionError && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        )}

        {!session ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("exam:startExamHeading")}</CardTitle>
            </CardHeader>
            <CardContent>
              {(() => {
                const nextPatient = currentPatientOf(queue);
                return nextPatient ? (
                  <p>{t("exam:startExamWithPatient", { patient: nextPatient.patientFirstName })}</p>
                ) : (
                  <p className="text-muted-foreground">{t("exam:startExamNoPatient")}</p>
                );
              })()}
              {startError && (
                <Alert variant="destructive" className="mb-3">
                  <AlertDescription>{startError}</AlertDescription>
                </Alert>
              )}
              <Button onClick={() => void startExam()} disabled={starting || equipment.status !== "ONLINE"}>
                {starting ? t("exam:starting") : t("exam:startExamButton")}
              </Button>
              {equipment.status !== "ONLINE" && <p className="mt-2 text-sm text-destructive">{t("exam:equipmentOffline")}</p>}

              {/* `<h2>`, not `<h3>`: shadcn's `CardTitle` above renders a plain `<div>`, not
                  a real heading element, so the only actual heading before this one is the
                  page's own hidden `<h1>` -- an `<h3>` here would skip a level (axe's own
                  heading-order rule caught this immediately). */}
              <h2 className="mt-6 text-base font-semibold">{t("exam:queueHeading")}</h2>
              <QueueStrip queue={queue} selectedId={selectedQueueEntryId} onSelect={selectPatient} vertical />
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Top queue rail -- read-only and horizontal, matching the mock's own "Fila do
                Scanner" strip. Reordering stays the nurse's job (NursingPage's own queue
                card, drag-and-drop); this rail is select-to-view only, same as QueueStrip's
                own docstring already states. Heading and strip share one row (`flex-row`,
                overriding Card's own `flex-col`) -- the wrapper div's `min-w-0` is what lets
                QueueStrip's own `overflow-x-auto` (QueueStrip.tsx) actually engage: a flex
                item's default `min-width: auto` would otherwise refuse to shrink below the
                queue's full content width, growing the card instead of scrolling it. */}
            <Card className="mb-4 flex-row items-center gap-4 p-3">
              <h2 className="flex-none text-[13px] font-semibold text-muted-foreground">{t("exam:queueHeading")}</h2>
              <div className="min-w-0 flex-1">
                <QueueStrip queue={queue} selectedId={selectedQueueEntryId} onSelect={selectPatient} />
              </div>
            </Card>

            <div className="grid grid-cols-[380px_minmax(0,1fr)_400px] items-start gap-4 max-[1300px]:grid-cols-1">
              {/* LEFT: room camera (full-width in its column, bigger than the old sidebar
                  card) + the room's own chat, given the rest of the column's height. */}
              <div className="flex h-full flex-col gap-4">
                <RoomCameraPanel whepUrl={equipment.cameraUrl} />

                <Card className="flex min-h-100 flex-1 flex-col">
                  <CardHeader>
                    <CardTitle className="text-[1.1em]">{t("exam:chatHeading")}</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-1 min-h-0 flex-col">
                    <ExamChat
                      messages={messages}
                      shortcuts={shortcuts}
                      currentUserId={user?.sub}
                      onSend={sendChatMessage}
                      onCreateShortcut={createShortcut}
                      creatingShortcut={creatingShortcut}
                      createShortcutError={createShortcutError}
                      day={chatDay}
                      onDayChange={setChatDay}
                      loadError={chatLoadError}
                    />
                  </CardContent>
                </Card>
              </div>

              {/* CENTER: reserved for the PiKVM console mirror -- no other panel competes
                  with it for this column, per this page's own "no fabricated telemetry"
                  policy above. */}
              <div className="flex flex-col gap-4">
                {!isController && (
                  <div className="rounded-md bg-destructive px-4 py-2.5 font-semibold text-white" role="status">
                    {t("exam:notInControl")}
                  </div>
                )}
                {/* This box (and the `.hud`-equivalent overlay inside it) stays black regardless
                    of the app's own theme -- a real video surface, not page chrome, so it keeps
                    its own self-contained colors exactly like a `Badge` does, per the "shared
                    ancestor" rule (see docs/architecture.md). The canvas itself keeps `w-full
                    block` and no other sizing utility -- see `SessionPage`'s identical console
                    box for why: `useHidInput`'s own mouse-coordinate math assumes its CSS box
                    always matches its intrinsic aspect ratio with zero letterboxing. */}
                <div
                  className="relative overflow-hidden rounded-lg bg-black focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-primary focus-visible:outline-offset-2"
                  ref={containerRef}
                  tabIndex={0}
                  role="group"
                  aria-label={t("exam:consoleAriaLabel", { room: roomHeading })}
                >
                  <canvas ref={canvasRef} role="img" aria-label={t("exam:consoleAriaLabel", { room: roomHeading })} className="block w-full" />
                  <div className="pointer-events-none absolute top-2 left-2 rounded-md bg-black/60 px-2.5 py-1.5 font-mono text-xs text-white" aria-hidden="true">
                    <div>stream: {streamState.status}</div>
                    <div>input RTT: {rttMs !== null ? `${rttMs} ms` : "—"}</div>
                  </div>
                  {streamState.status === "error" && (
                    <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-black/60 px-2.5 py-1.5 font-mono text-xs text-white" role="alert">
                      {streamState.info}
                    </div>
                  )}
                </div>
              </div>

              {/* RIGHT: the active patient's record, then every action button -- the mock's
                  own "Ficha do Paciente Ativo" / "Alertas Clínicos" / "Ações" stack. */}
              <div className="flex flex-col gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-[1.1em]">{t("exam:patientCardHeading")}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {!selectedEntry ? (
                      <p className="text-sm text-muted-foreground">{t("exam:patientCardEmpty")}</p>
                    ) : (
                      <>
                        <div className="mb-3 flex items-center justify-between gap-2">
                          <span className="text-[15px] font-semibold">{selectedEntry.patientFirstName}</span>
                          <Badge className={cn("border-transparent", preparationStatusBadgeClass(selectedEntry.preparationStatus))}>
                            {t(preparationStatusLabelKeyOf(selectedEntry.preparationStatus))}
                          </Badge>
                        </div>
                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
                          {selectedEntry.examDescription && (
                            <>
                              <dt className="font-semibold text-muted-foreground">{t("exam:patientExamLabel")}</dt>
                              <dd className="m-0">{selectedEntry.examDescription}</dd>
                            </>
                          )}
                          {selectedEntry.patientSex && (
                            <>
                              <dt className="font-semibold text-muted-foreground">{t("exam:patientSexLabel")}</dt>
                              <dd className="m-0">{t(patientSexLabelKeyOf(selectedEntry.patientSex))}</dd>
                            </>
                          )}
                          {selectedEntry.patientWeightKg != null && (
                            <>
                              <dt className="font-semibold text-muted-foreground">{t("exam:patientWeightLabel")}</dt>
                              <dd className="m-0">{selectedEntry.patientWeightKg} kg</dd>
                            </>
                          )}
                          {selectedEntry.contrastRequired && (
                            <>
                              <dt className="font-semibold text-muted-foreground">{t("exam:contrastLabel")}</dt>
                              <dd className="m-0">
                                {selectedEntry.contrastVolumeMl != null ? `${selectedEntry.contrastVolumeMl} ml` : t("exam:contrastYes")}
                              </dd>
                            </>
                          )}
                        </dl>
                      </>
                    )}
                  </CardContent>
                </Card>

                {selectedEntry &&
                  (selectedEntry.allergyStatus ||
                    selectedEntry.fastingConfirmed ||
                    selectedEntry.creatinineMgDl != null ||
                    selectedEntry.metforminUse === true ||
                    selectedEntry.anticoagulantUse === true) && (
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-[1.1em]">{t("exam:alertsCardHeading")}</CardTitle>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-2 text-[13px]">
                        {selectedEntry.allergyStatus && (
                          <div className="flex items-center gap-1.5">
                            {selectedEntry.allergyStatus === AllergyStatus.PRESENT ? (
                              <ShieldAlert className="size-3.5 text-destructive" />
                            ) : (
                              <ShieldCheck className="size-3.5 text-[#5fdc8a]" />
                            )}
                            <span>
                              {t(allergyStatusLabelKeyOf(selectedEntry.allergyStatus))}
                              {selectedEntry.allergyStatus === AllergyStatus.PRESENT && selectedEntry.allergyNotes
                                ? ` — ${selectedEntry.allergyNotes}`
                                : ""}
                            </span>
                          </div>
                        )}
                        {selectedEntry.fastingConfirmed && (
                          <div>
                            {t("exam:fastingLabel")}: {selectedEntry.fastingHours != null ? `${selectedEntry.fastingHours} h` : t("exam:fastingYes")}
                          </div>
                        )}
                        {selectedEntry.creatinineMgDl != null && (
                          <div>
                            {t("exam:creatinineLabel")}: {selectedEntry.creatinineMgDl} mg/dL
                          </div>
                        )}
                        {/* Shown only when `true` -- same "noteworthy facts only" posture as
                            fastingConfirmed above; `false`/`null` have nothing an operator
                            needs flagged. */}
                        {selectedEntry.metforminUse === true && (
                          <div className="flex items-center gap-1.5">
                            <ShieldAlert className="size-3.5 text-destructive" />
                            <span>{t("exam:metforminUseAlert")}</span>
                          </div>
                        )}
                        {selectedEntry.anticoagulantUse === true && (
                          <div className="flex items-center gap-1.5">
                            <ShieldAlert className="size-3.5 text-destructive" />
                            <span>{t("exam:anticoagulantUseAlert")}</span>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}

                {selectedEntry && selectedEntry.documents.length > 0 && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-[1.1em]">{t("exam:documentsCardHeading")}</CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-1.5">
                      {selectedEntry.documents.map((document) => (
                        <ExamDocumentRow key={document.id} queueEntryId={selectedEntry.id} document={document} />
                      ))}
                    </CardContent>
                  </Card>
                )}


                {selectedEntry?.preparationNotes && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-[1.1em]">{t("exam:nursingNotesLabel")}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-[13px] whitespace-pre-wrap">{selectedEntry.preparationNotes}</p>
                    </CardContent>
                  </Card>
                )}

                <Card>
                  <CardHeader>
                    <CardTitle className="text-[1.1em]">{t("exam:teleoperationNotesLabel")}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Textarea
                      aria-label={t("exam:teleoperationNotesLabel")}
                      rows={3}
                      value={notesDraft}
                      disabled={!selectedEntry || !notesEditable || notesSaving}
                      onChange={(e) => setNotesDraft(e.target.value)}
                    />
                    {selectedEntry && !notesEditable && <p className="mt-1.5 text-sm text-destructive">{t("exam:notesLockedNote")}</p>}
                    {notesError && (
                      <Alert variant="destructive" className="mt-2">
                        <AlertDescription>{notesError}</AlertDescription>
                      </Alert>
                    )}
                    <Button
                      className="mt-2.5"
                      onClick={() => void saveTeleoperationNotes()}
                      disabled={!selectedEntry || !notesEditable || notesSaving || notesDraft === (selectedEntry?.teleoperationNotes ?? "")}
                    >
                      {notesSaving ? t("exam:saving") : t("exam:save")}
                    </Button>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-[1.1em]" id="exam-type-text-heading">
                      {t("exam:typeTextHeading")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <form onSubmit={submitPrintText}>
                      <div className="mb-3.5 flex flex-col gap-1.5">
                        <Label htmlFor="exam-print-text" className="sr-only">
                          {t("exam:typeTextInputLabel")}
                        </Label>
                        <Input
                          id="exam-print-text"
                          aria-describedby="exam-type-text-heading"
                          value={printText}
                          onChange={(e) => setPrintText(e.target.value)}
                          disabled={!isController}
                          placeholder={t("exam:typeTextPlaceholder")}
                        />
                      </div>
                      <Button type="submit" disabled={!isController || !printText}>
                        {t("exam:typeTextSend")}
                      </Button>
                      {printSent && (
                        <p role="status" className="mt-2 text-[13px] text-[#166534]">
                          {t("exam:typeTextSent")}
                        </p>
                      )}
                    </form>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="flex flex-col gap-2.5">
                    <Button variant="secondary" onClick={emergencyReleaseAll} disabled={releasing} className="w-full">
                      {releasing ? t("exam:releasing") : t("exam:emergencyRelease")}
                    </Button>
                    {isParticipant && (
                      <Button onClick={endSession} disabled={ending} className="w-full">
                        {ending ? t("exam:ending") : t("exam:endExamAndReleaseRoom")}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

/**
 * One of the nurse's uploaded exam documents, read-only here -- the operator has no upload
 * or remove affordance for this list at all (see `QueueController`'s own routes: the two
 * write routes are nurse-side only, this content route is the one the operator's own
 * `OperatorAccessService.assertCanReachEquipmentId` check actually gates). Same click-to-
 * download-via-blob shape `ExamChat`'s own `ChatAttachment` and `NursingPage`'s
 * `QueueDocumentRow` already use, for the identical reason: the content route is
 * authenticated, so a bare `<a href>` cannot carry the Authorization header.
 */
function ExamDocumentRow({ queueEntryId, document }: { queueEntryId: string; document: QueueEntryDto["documents"][number] }) {
  const { t } = useTranslation(["exam"]);
  const [downloading, setDownloading] = useState(false);

  async function download() {
    setDownloading(true);
    try {
      const blob = await api.getBlob(`/queue/${queueEntryId}/documents/${document.id}/content`);
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement("a");
      link.href = url;
      link.download = document.filename;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <button
      type="button"
      className="flex items-center gap-1.5 rounded-md border bg-background px-2 py-1.5 text-left text-[13px] disabled:opacity-60"
      onClick={() => void download()}
      disabled={downloading}
    >
      <FileText className="size-3.5 flex-shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{document.filename}</span>
      <span className="flex-shrink-0 text-xs text-muted-foreground">({humanFileSize(document.sizeBytes)})</span>
      <Download className="size-3.5 flex-shrink-0 text-muted-foreground" aria-label={t("exam:downloadDocument")} />
    </button>
  );
}

