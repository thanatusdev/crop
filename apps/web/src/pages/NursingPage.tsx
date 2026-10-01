import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  AllergyStatus,
  PatientSex,
  PreparationStatus,
  QueueDocumentKind,
  QueueStatus,
  RT_EVENTS,
  clinicTimeToUtcIso,
  formatClinicTime,
  todayClinicDayString,
  type EquipmentDto,
  type ExamMessageDto,
  type MeResponse,
  type MessageShortcutDto,
  type PatientPreparationUpdatedEvent,
  type QueueEntryDocumentDto,
  type QueueEntryDto,
  type QueueTimelineEntry,
  type SessionState,
  type UnitDto,
} from "@crop/shared";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  FileText,
  History,
  ListChecks,
  Loader2,
  Lock,
  LogOut,
  MapPin,
  MessageCircle,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Syringe,
  Trash2,
  User,
  UserCheck,
  Wifi,
} from "lucide-react";
import { cn } from "cn";
import { api, ApiError } from "../lib/api-client.js";
import { useAuth } from "../lib/auth-context.js";
import { createSessionSocket } from "../lib/socket-client.js";
import { ConsoleShell } from "../components/ConsoleShell.js";
import { ExamChat } from "../components/ExamChat.js";
import { FileDropzone } from "../components/FileDropzone.js";
import { Modal } from "../components/Modal.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Textarea } from "../components/ui/textarea.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { Badge } from "../components/ui/badge.js";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { MODALITY_ABBREVIATION } from "../lib/equipment-display.js";
import { humanFileSize } from "../lib/file-display.js";
import {
  allergyStatusLabelKeyOf,
  applyReorderDraft,
  arraysEqual,
  availablePreparationActions,
  currentPatientOf,
  isAwaitingPositioning,
  isDetailsEditable,
  isReorderable,
  patientSexLabelKeyOf,
  queueCardChipOf,
  timelineActionLabelKeyOf,
} from "../lib/queue-display.js";

/**
 * The Nurse role's main screen: the day's patient queue for one room, built from a second
 * RadLink Teleoperation prototype (the "Fila da Sala 1, Tomografia" full-day view) on top of
 * the quick-action/reorder/exam-details screen two earlier tasks already built here. See the
 * `nursing` namespace's own docstring in pt-BR.ts for the exhaustive "reproduced vs.
 * deliberately not" list against *that* mock.
 *
 * Rebuilt on shadcn/ui (Radix + Tailwind) in a later pass, replacing every hand-rolled
 * `.card`/`.field`/`.badge` element from the old stylesheet with `Button`/`Input`/`Select`/
 * `Badge`/`Alert`/etc. Two real, user-reported bugs drove that pass, not aesthetics alone:
 *
 *  - **The exam-data summary used to be a separate overlay layered on top of this card**
 *    (`ExamDataOverlay`, now deleted), positioned in the same CSS grid cell as the "Detalhes
 *    do Exame" card so it could cover it without affecting layout. That overlay's header --
 *    which is where it lived -- sat directly on top of this card's own "Habilitar Edição"
 *    button, making it genuinely unreachable while a patient was "Aguardando
 *    Posicionamento" (a real bug report: "I don't have a way to edit the patient info").
 *    Fixed by merging the two into *one* card with *one* toggle: `editMode` now switches the
 *    same card between a read-only summary (below) and the editable form it always had --
 *    there is no longer a second surface that can cover the first.
 *  - **Every modal on this page (`Modal.tsx`) used to lose focus on every keystroke** --
 *    see `Modal`'s own docstring for the root cause (an effect keyed to an inline arrow
 *    function's identity). Fixed once, structurally, by rebuilding `Modal` on Radix's
 *    `Dialog`, not per call site.
 *
 *  1. **The day scope itself.** `?date=` (always today's clinic-local calendar day --
 *     see `clinic-day.ts`; there is no date picker in this pass, "the day's queue" means
 *     *today's*) is passed to `GET /queue`, so `queue.length` is an honest "N Pacientes
 *     Hoje" rather than every entry this room has ever had. Every scheduled-time read/write
 *     goes through `clinicTimeToUtcIso`/`formatClinicTime` now too, fixing a real bug the
 *     previous pass left in place: the exam-detail form used to write a nurse's typed time
 *     as a bare UTC instant and read it back the same way, self-consistent only because
 *     nothing before this feature ever compared it against a server-computed day boundary.
 *  2. **A real room-context header** (`Sala 1, Tomografia · Unidade · GE Revolution 64C`) --
 *     `Equipment.roomLabel`/`modality`/`brand`/`model` plus `Unit.name` are all real data
 *     that simply had nowhere to render before this screen existed.
 *  3. **Read-only by default, with an explicit "Habilitar Edição" toggle** -- gates the
 *     exam-detail *fields* only; the preparation quick-actions below stay live regardless
 *     (a clinical act, not a record edit), matching the source mock exactly (padlocked
 *     fields shown alongside an active "Paciente Posicionado" button).
 *  4. **The structured safety questionnaire** (fasting/creatinine/allergy/contrast-volume),
 *     a real "Novo Exame" modal, exam-detail write attribution ("Registrado às HH:mm por
 *     <nome>"), and a per-exam timeline + "Operador Remoto" card replacing the source
 *     mock's Chat/Áudio/Segurança-da-Sala panels (no messaging, audio, or sensor telemetry
 *     exists anywhere in this codebase -- see this file's own "not reproduced" table below).
 *  5. **An exam-data summary while the current patient is "Awaiting Positioning"** -- built
 *     from a *third* RadLink prototype (the Teleoperação cockpit's own "Dados do Exame ·
 *     Paciente em Preparação" panel), shown automatically in the *same* "Detalhes do Exame"
 *     card whenever `currentPatientOf(queue)` still has `preparationStatus === NOT_STARTED`
 *     (see `isAwaitingPositioning` in queue-display.ts for why that -- not a new enum
 *     value -- is the honest mapping of "Awaiting Positioning"). Auto-selects that patient
 *     only if the nurse hasn't already picked a different one to look at.
 *
 * Room/equipment selection lives in the URL (`?equipmentId=`), same convention as
 * `AdminEquipmentPage`'s filters. All fetching is `useEffect` + `api.get`/`api.post` with
 * local `loading`/`error` state -- there is no react-query or similar in this codebase.
 *
 * Not reproduced from this pass's own source mocks, each for a specific, existing reason
 * (same policy as every prior feature built from a screenshot -- see `nursing`'s own
 * docstring above for the precedent):
 *
 * | Prototype element | Why not |
 * |---|---|
 * | Chat Operacional do Exame, Canal de Áudio (PTT/"Voz no Gantry"), Segurança da Sala (porta/clima/parada de emergência) | No messaging, audio, or sensor-telemetry transport exists anywhere in this codebase -- replaced with a real per-exam audit timeline + the actual "Operador Remoto" identity, not a fabrication of any of the three |
 * | Questionário de Segurança as its own generated/uploaded PDF ("Revisar Respostas") | The questionnaire's three *facts* (fastingConfirmed/creatinineMgDl/allergyStatus) are real structured fields, each editable and auditable on its own -- a PDF rendering of them would be a second, less honest copy of data that already has a canonical home |
 * | "Dose Est.: ~102 ml (1,5ml/kg)" / overlay's "Dose: 1,25 ml/kg" | Recording a nurse-entered `contrastVolumeMl` from the exam's own protocol, never a value this platform computes from weight -- rendering a dosing calculation is a clinical claim this project has no basis to make |
 * | Free-text "+ Adicionar Tag" observation chips, "Macros Rápidas de Sala" canned messages | This repo prefers closed enums over open typed-string taxonomies (see `ExamModality`'s own docstring); the macros specifically would need a real chat channel to land anywhere honest |
 * | Age/date-of-birth, full name, prontuário/CNS numbers | Only `patientFirstName` is stored, by deliberate PHI minimization -- unchanged across every nursing task |
 * | Top horizontal nav (Cockpit/Exames/Enfermagem/Supervisão/Equipamentos), "Intercorrência"/"Parada Emergencial" buttons | `ConsoleShell`'s sidebar is this app's real chrome; the one real emergency control (`release-all`) already lives on `SessionPage`, for the Biomédico Operador actually driving the equipment |
 * | A date picker / previous days | Out of scope for this pass -- "the day's queue" is today's; browsing other days is a real, separate follow-up |
 * | "Assinatura ICP-Brasil Válida" badge, physician name/CRM read off the uploaded PDF | **Partially superseded** -- uploading the Pedido Médico/Laudo Anterior itself is now real (`QueueEntryDocument`, this card's own "Documentação do Exame" section). What's still refused is verifying an ICP-Brasil signature (real PKI chain verification this platform has no basis to perform) and extracting a physician's name/CRM from the PDF's contents (this app records *who uploaded it and when*, via the same audit-grade attribution every other write here gets -- never who signed the document itself, which nothing here parses) |
 * | "TAXA FILTRAÇÃO (eGFR CKD-EPI) ... Estágio 1" computed filtration-rate card | A computed clinical value needing the patient's age, which this schema deliberately does not store (PHI minimization) -- same refusal as the contrast-dose calculation two rows up, for the identical reason |
 * | Invented exam protocol code ("TC-TORAX-02") | No protocol/procedure-code taxonomy exists in this schema; `examDescription` is the one free-text field that already carries this information |
 */
export default function NursingPage() {
  const { t } = useTranslation(["nursing"]);
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const selectedEquipmentId = params.get("equipmentId") ?? "";
  const today = useMemo(() => todayClinicDayString(), []);

  const [me, setMe] = useState<MeResponse | null>(null);

  useEffect(() => {
    void api
      .get<MeResponse>("/auth/me")
      .then(setMe)
      .catch(() => {
        // Non-fatal, decorative only -- the room header just omits the "who's signed in"
        // line, same "best-effort" reasoning as ConsoleShell's own health-pill fetch.
      });
  }, []);

  const [equipmentList, setEquipmentList] = useState<EquipmentDto[]>([]);
  const [units, setUnits] = useState<UnitDto[]>([]);
  const [equipmentError, setEquipmentError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueEntryDto[]>([]);
  const [activeSession, setActiveSession] = useState<SessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionEntryId, setActionEntryId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    // `/equipment` and `/units` are scoped to the caller's *active* tenant server-side -- same
    // reasoning as ConsoleShell's own fix for the multi-clinic-Manager staleness bug.
    void loadEquipmentList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.tenantId]);

  async function loadEquipmentList() {
    try {
      const [list, unitList] = await Promise.all([api.get<EquipmentDto[]>("/equipment"), api.get<UnitDto[]>("/units")]);
      setEquipmentList(list);
      setUnits(unitList);
      // Default to the first room once the list arrives, if the URL didn't already name one
      // (e.g. a fresh visit to /enfermagem with no query string yet).
      if (!selectedEquipmentId && list.length > 0) {
        const next = new URLSearchParams(params);
        next.set("equipmentId", list[0]!.id);
        setParams(next, { replace: true });
      }
    } catch (err) {
      setEquipmentError(err instanceof Error ? err.message : t("nursing:loadError"));
    }
  }

  const selectedEquipment = equipmentList.find((e) => e.id === selectedEquipmentId) ?? null;
  const selectedUnit = selectedEquipment?.unitId ? units.find((u) => u.id === selectedEquipment.unitId) ?? null : null;
  const roomHeading = selectedEquipment?.roomLabel ?? selectedEquipment?.name ?? "";
  const roomSubtitle = selectedEquipment
    ? [
        selectedEquipment.modality ? MODALITY_ABBREVIATION[selectedEquipment.modality] : null,
        selectedUnit?.name ?? null,
        [selectedEquipment.brand, selectedEquipment.model].filter(Boolean).join(" ") || null,
      ]
        .filter((part): part is string => !!part)
        .join(" · ")
    : "";

  // Whether the current room's "current patient" (see currentPatientOf) has already been
  // auto-selected into the details card once -- reset whenever the room itself changes, so
  // switching rooms gets its own fresh auto-select instead of silently doing nothing because
  // a *previous* room's auto-select already flipped this to true.
  const autoSelectedRef = useRef(false);

  useEffect(() => {
    if (!selectedEquipmentId) {
      setLoading(false);
      return;
    }
    void loadQueueAndSession(selectedEquipmentId);
    // Switching rooms discards any unconfirmed reorder draft / details edit for the
    // previous room -- there is nothing sensible to carry across equipment.
    setSelectedEntryId(null);
    setStaleQueueNotice(false);
    autoSelectedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEquipmentId]);

  async function loadQueueAndSession(equipmentId: string) {
    setLoading(true);
    setLoadError(null);
    try {
      const [queueList, sessions] = await Promise.all([
        api.get<QueueEntryDto[]>(`/queue?equipmentId=${equipmentId}&date=${today}`),
        api.get<SessionState[]>("/sessions/active"),
      ]);
      setQueue(queueList);
      setActiveSession(sessions.find((s) => s.equipmentId === equipmentId) ?? null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("nursing:loadError"));
    } finally {
      setLoading(false);
    }
  }

  // Live push: another nurse (or this same nurse, from a second tab) advancing a patient's
  // preparation status or reordering the room, or the Biomédico Operador starting/ending the
  // exam that flips the lock banner, would otherwise only ever show up here after a manual
  // reload -- see RT_EVENTS.PATIENT_PREPARATION_UPDATED/QUEUE_UPDATED. Re-fetches both the
  // queue and the active-session list rather than patching state in place: QUEUE_UPDATED in
  // particular can mean the lock itself, or the room's whole order, just changed, which this
  // page has no cheaper way to recompute.
  //
  // Also joins the room's own exam-support chat (`JOIN_EQUIPMENT_CHAT`) -- this is the one
  // socket connection nursing ever opens, so the chat card below rides on it rather than a
  // second connection. Re-created whenever `chatDay` changes too (not just the room), so a
  // stale closure over an old day can never filter `EXAM_MESSAGE_CREATED` against the wrong
  // one -- see the handler below.
  const [chatMessages, setChatMessages] = useState<ExamMessageDto[]>([]);
  const [chatDay, setChatDay] = useState(today);
  const [chatShortcuts, setChatShortcuts] = useState<MessageShortcutDto[]>([]);
  const [chatLoadError, setChatLoadError] = useState<string | null>(null);
  const [creatingShortcut, setCreatingShortcut] = useState(false);
  const [createShortcutError, setCreateShortcutError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedEquipmentId) return;
    const sock = createSessionSocket();
    sock.connect();
    sock.on("connect", () => sock.emit(RT_EVENTS.JOIN_EQUIPMENT_CHAT, { equipmentId: selectedEquipmentId }));
    const onQueueUpdated = (payload: { equipmentId: string }) => {
      if (payload.equipmentId === selectedEquipmentId) void loadQueueAndSession(selectedEquipmentId);
    };
    const onPreparationUpdated = (payload: PatientPreparationUpdatedEvent) => {
      if (payload.equipmentId === selectedEquipmentId) void loadQueueAndSession(selectedEquipmentId);
    };
    const onExamMessageCreated = (payload: ExamMessageDto) => {
      setChatMessages((prev) => (payload.createdAt.slice(0, 10) === chatDay ? [...prev, payload] : prev));
    };
    sock.on(RT_EVENTS.QUEUE_UPDATED, onQueueUpdated);
    sock.on(RT_EVENTS.PATIENT_PREPARATION_UPDATED, onPreparationUpdated);
    sock.on(RT_EVENTS.EXAM_MESSAGE_CREATED, onExamMessageCreated);
    return () => {
      sock.disconnect();
    };
  }, [selectedEquipmentId, chatDay]);

  // The chat transcript itself, day-scoped -- reloaded whenever the room or the shown day
  // changes. Shortcuts don't vary by day; refetching them alongside keeps this one effect
  // instead of two nearly-identical ones (same reasoning ExamPage's own chat-load effect
  // gives).
  useEffect(() => {
    if (!selectedEquipmentId) return;
    let cancelled = false;
    setChatLoadError(null);
    void Promise.all([
      api.get<ExamMessageDto[]>(`/chat/messages?equipmentId=${selectedEquipmentId}&date=${chatDay}`),
      api.get<MessageShortcutDto[]>("/chat/shortcuts"),
    ])
      .then(([messageList, shortcutList]) => {
        if (cancelled) return;
        setChatMessages(messageList);
        setChatShortcuts(shortcutList);
      })
      .catch((err) => {
        if (!cancelled) setChatLoadError(err instanceof Error ? err.message : t("nursing:chatLoadError"));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedEquipmentId, chatDay, t]);

  async function sendChatMessage(body: string, file: File | null) {
    const form = new FormData();
    form.append("equipmentId", selectedEquipmentId);
    form.append("body", body);
    if (file) form.append("file", file);
    await api.postForm(`/chat/messages`, form);
  }

  async function createChatShortcut(input: { code: string; label: string; body: string }) {
    setCreatingShortcut(true);
    setCreateShortcutError(null);
    try {
      const created = await api.post<MessageShortcutDto>("/chat/shortcuts", input);
      setChatShortcuts((prev) => [...prev, created]);
    } catch (err) {
      setCreateShortcutError(err instanceof ApiError ? err.message : t("nursing:chatShortcutError"));
      throw err;
    } finally {
      setCreatingShortcut(false);
    }
  }

  const currentPatient = useMemo(() => currentPatientOf(queue), [queue]);

  // The database, not this flag, is the real guarantee (sessions_one_active_per_equipment +
  // the release-gate check inside UpdatePreparationStatusHandler) -- this only mirrors it so
  // the "Paciente Liberado" button is visibly disabled instead of failing with a 409 the
  // nurse has to read a toast to understand.
  const releaseBlockedByActiveSession = (entry: QueueEntryDto): boolean =>
    activeSession?.status === "ACTIVE" && activeSession.queueEntryId === entry.id;

  async function updatePreparation(queueEntryId: string, status: PreparationStatus) {
    setActionError(null);
    setActionEntryId(queueEntryId);
    try {
      await api.post(`/queue/${queueEntryId}/preparation`, { status });
      await loadQueueAndSession(selectedEquipmentId);
      // This just wrote a PATIENT_POSITIONED/INJECTED/RELEASED audit row -- refresh the
      // timeline panel so it shows up without needing a re-selection.
      setTimelineNonce((n) => n + 1);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("nursing:actionError"));
    } finally {
      setActionEntryId(null);
    }
  }

  // ------------------------------------------------------------------------------------
  // "Novo Exame" modal
  // ------------------------------------------------------------------------------------

  const [newExamOpen, setNewExamOpen] = useState(false);
  const [newExamName, setNewExamName] = useState("");
  const [newExamTime, setNewExamTime] = useState("");
  const [newExamSaving, setNewExamSaving] = useState(false);
  const [newExamError, setNewExamError] = useState<string | null>(null);
  const newExamTriggerRef = useRef<HTMLElement | null>(null);

  function openNewExamModal(ev: React.MouseEvent<HTMLButtonElement>) {
    newExamTriggerRef.current = ev.currentTarget;
    setNewExamName("");
    setNewExamTime("");
    setNewExamError(null);
    setNewExamOpen(true);
  }

  async function submitNewExam() {
    if (!newExamName.trim()) {
      setNewExamError(t("nursing:newExamNameRequired"));
      return;
    }
    setNewExamSaving(true);
    setNewExamError(null);
    try {
      await api.post("/queue", {
        equipmentId: selectedEquipmentId,
        patientFirstName: newExamName.trim(),
        scheduledAt: newExamTime ? clinicTimeToUtcIso(today, newExamTime) : undefined,
      });
      await loadQueueAndSession(selectedEquipmentId);
      setNewExamOpen(false);
    } catch (err) {
      setNewExamError(err instanceof ApiError ? err.message : t("nursing:newExamError"));
    } finally {
      setNewExamSaving(false);
    }
  }

  // ------------------------------------------------------------------------------------
  // Queue reordering
  // ------------------------------------------------------------------------------------

  const [draftOrder, setDraftOrder] = useState<string[]>([]);
  const [staleQueueNotice, setStaleQueueNotice] = useState(false);
  const [reorderSaving, setReorderSaving] = useState(false);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [moveAnnouncement, setMoveAnnouncement] = useState("");
  // The server's own current WAITING order, as of the last time it was adopted into
  // draftOrder -- used only to detect whether draftOrder has since diverged (the nurse is
  // mid-edit) versus whether a *new* server order has arrived underneath an existing draft
  // (see the effect below). Not itself rendered.
  const lastServerOrderRef = useRef<string[]>([]);

  function waitingOrderOf(list: readonly QueueEntryDto[]): string[] {
    return list
      .filter(isReorderable)
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((entry) => entry.id);
  }

  // Keeps draftOrder in sync with the server's own order, without ever silently discarding
  // an unconfirmed draft: if the draft wasn't dirty, adopt whatever the server now says; if
  // it *was* dirty and the server's order genuinely moved underneath it (another device
  // reordered, or a patient left WAITING), surface that as staleQueueNotice instead of
  // overwriting -- confirmReorder itself resolves this deliberately (see its own comment).
  useEffect(() => {
    const serverOrder = waitingOrderOf(queue);
    const wasDirty = !arraysEqual(draftOrder, lastServerOrderRef.current);
    if (!wasDirty) {
      setDraftOrder(serverOrder);
    } else if (!arraysEqual(serverOrder, lastServerOrderRef.current)) {
      setStaleQueueNotice(true);
    }
    lastServerOrderRef.current = serverOrder;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue]);

  const isReorderDirty = !arraysEqual(draftOrder, lastServerOrderRef.current);
  const displayQueue = useMemo(() => applyReorderDraft(queue, draftOrder), [queue, draftOrder]);

  function announceMove(id: string, nextOrder: readonly string[]) {
    const patient = queue.find((entry) => entry.id === id);
    const position = nextOrder.indexOf(id);
    if (!patient || position < 0) return;
    setMoveAnnouncement(t("nursing:moveAnnouncement", { patient: patient.patientFirstName, position: position + 1, total: nextOrder.length }));
  }

  function moveDraft(id: string, direction: -1 | 1) {
    setDraftOrder((prev) => {
      const index = prev.indexOf(id);
      const swapIndex = index + direction;
      if (index < 0 || swapIndex < 0 || swapIndex >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[swapIndex]] = [next[swapIndex]!, next[index]!];
      announceMove(id, next);
      return next;
    });
  }

  function onDropCard(overId: string) {
    if (draggingId && draggingId !== overId) {
      setDraftOrder((prev) => {
        const from = prev.indexOf(draggingId);
        const to = prev.indexOf(overId);
        if (from < 0 || to < 0) return prev;
        const next = [...prev];
        next.splice(from, 1);
        next.splice(to, 0, draggingId);
        announceMove(draggingId, next);
        return next;
      });
    }
    setDraggingId(null);
    setDropTargetId(null);
  }

  // "Restaurar Ordem Original" and "Cancelar Alterações" are the same operation here
  // (there is no separate "editing mode" to exit -- the banner is driven purely by
  // isReorderDirty, so resetting the draft to the server's order does both at once): the
  // prototype showed them as two buttons, kept as two for recognizability against that
  // source mock, but neither does more than the other.
  function resetDraftToServerOrder() {
    setDraftOrder(lastServerOrderRef.current);
    setReorderError(null);
  }

  async function confirmReorder() {
    if (!isReorderDirty || draftOrder.length < 2) return;
    setReorderSaving(true);
    setReorderError(null);
    try {
      await api.post("/queue/reorder", { equipmentId: selectedEquipmentId, orderedIds: draftOrder });
      // The server now matches exactly what was just submitted -- recorded here, before the
      // reload's own queue update lands, so the sync effect above sees a non-dirty draft
      // and doesn't mistake this confirm's own effect for a stale-elsewhere change.
      lastServerOrderRef.current = draftOrder;
      await loadQueueAndSession(selectedEquipmentId);
      setStaleQueueNotice(false);
    } catch (err) {
      setReorderError(err instanceof ApiError ? err.message : t("nursing:reorderError"));
    } finally {
      setReorderSaving(false);
    }
  }

  function reloadDiscardingReorderDraft() {
    const serverOrder = waitingOrderOf(queue);
    setDraftOrder(serverOrder);
    lastServerOrderRef.current = serverOrder;
    setStaleQueueNotice(false);
  }

  // ------------------------------------------------------------------------------------
  // Exam details (per-patient card) -- read-only summary by default; "Habilitar Edição"
  // switches the *same* card into the editable form, never the preparation quick-actions
  // below it. See this file's own docstring for why this is one card with one toggle,
  // not a summary overlay layered on top of the form (the design this replaced).
  // ------------------------------------------------------------------------------------

  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [detailsDraft, setDetailsDraft] = useState<DetailsDraft>(emptyDetailsDraft());
  const [detailsDirty, setDetailsDirty] = useState(false);
  const [detailsSaving, setDetailsSaving] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailsFieldErrors, setDetailsFieldErrors] = useState<Record<string, string>>({});
  const [detailsStaleNotice, setDetailsStaleNotice] = useState(false);
  const lastLoadedDetailsRef = useRef<QueueEntryDto | null>(null);

  // Document upload -- deliberately its own, separate state from the draft/dirty machinery
  // above: uploading/removing a document is immediate (its own route, its own audit event),
  // not part of "Salvar Alterações deste Paciente"/"Descartar Edição". See this card's own
  // JSX for the explicit note that follows from that.
  const [documentKind, setDocumentKind] = useState<QueueDocumentKind>(QueueDocumentKind.PEDIDO_MEDICO);
  const [documentUploading, setDocumentUploading] = useState(false);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [removingDocumentId, setRemovingDocumentId] = useState<string | null>(null);

  const selectedEntry = queue.find((entry) => entry.id === selectedEntryId) ?? null;

  function selectEntryForEditing(entry: QueueEntryDto) {
    setSelectedEntryId(entry.id);
    setEditMode(false);
    setDetailsDraft(draftFromEntry(entry));
    setDetailsDirty(false);
    setDetailsError(null);
    setDetailsFieldErrors({});
    setDetailsStaleNotice(false);
    setDocumentKind(QueueDocumentKind.PEDIDO_MEDICO);
    setDocumentError(null);
    lastLoadedDetailsRef.current = entry;
  }

  // Auto-selects the room's current "Aguardando Posicionamento" patient into the details
  // card, exactly once per room -- see `autoSelectedRef`'s own comment. Never overrides a
  // nurse's own manual selection: if she has already clicked a card (any card, including
  // this same patient's), that counts as "handled" and this effect stands down for good
  // until the next room switch. Declared here, after `selectEntryForEditing`/
  // `selectedEntryId` both exist, rather than up by `currentPatient` -- `const` bindings
  // (unlike a `function` declaration) are not hoisted, so referencing either one from an
  // effect declared above their own initialization is a real `ReferenceError` (caught by
  // `tsc`'s "used before its declaration" here, not just a style preference).
  useEffect(() => {
    if (autoSelectedRef.current) return;
    if (selectedEntryId) {
      autoSelectedRef.current = true;
      return;
    }
    if (currentPatient && isAwaitingPositioning(currentPatient)) {
      selectEntryForEditing(currentPatient);
      autoSelectedRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPatient, selectedEntryId]);

  // Re-syncs the details form when the *selected* entry's own server data changes (a live
  // push from another device) -- but only while the form isn't dirty; if the nurse has
  // unsaved edits, this surfaces detailsStaleNotice instead of silently overwriting them.
  useEffect(() => {
    if (!selectedEntry) return;
    if (!detailsDirty) {
      if (
        !lastLoadedDetailsRef.current ||
        lastLoadedDetailsRef.current.id !== selectedEntry.id ||
        hasDetailsChanged(lastLoadedDetailsRef.current, selectedEntry)
      ) {
        setDetailsDraft(draftFromEntry(selectedEntry));
        lastLoadedDetailsRef.current = selectedEntry;
      }
      return;
    }
    if (lastLoadedDetailsRef.current && hasDetailsChanged(lastLoadedDetailsRef.current, selectedEntry)) {
      setDetailsStaleNotice(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEntry]);

  function updateDraftField<K extends keyof DetailsDraft>(key: K, value: DetailsDraft[K]) {
    setDetailsDraft((prev) => ({ ...prev, [key]: value }));
    setDetailsDirty(true);
  }

  function discardDetailsEdit() {
    if (selectedEntry) selectEntryForEditing(selectedEntry);
  }

  function reloadDiscardingDetailsEdit() {
    if (selectedEntry) selectEntryForEditing(selectedEntry);
  }

  async function saveDetails() {
    if (!selectedEntry || !detailsDirty) return;
    setDetailsSaving(true);
    setDetailsError(null);
    setDetailsFieldErrors({});
    try {
      await api.patch(`/queue/${selectedEntry.id}`, detailsDraftToPatchBody(detailsDraft, today));
      await loadQueueAndSession(selectedEquipmentId);
      setDetailsDirty(false);
      // Back to the safe read-only view once a save succeeds -- matches the mock's own
      // per-card workflow (edit, save, the record is padlocked again).
      setEditMode(false);
      // This just wrote a QUEUE_ENTRY_UPDATED audit row -- refresh the timeline panel.
      setTimelineNonce((n) => n + 1);
    } catch (err) {
      if (err instanceof ApiError) {
        setDetailsError(err.message);
        setDetailsFieldErrors(Object.fromEntries(err.fieldErrors.map((e) => [e.path, e.message])));
      } else {
        setDetailsError(t("nursing:detailsError"));
      }
    } finally {
      setDetailsSaving(false);
    }
  }

  // Immediate, own route -- not staged with detailsDraft/detailsDirty above, and not undone
  // by "Descartar Edição" (see the card's own note in the JSX below). Client-side mime/size
  // checks are a UX nicety only; `UploadQueueDocumentHandler`'s own checks are the real gate,
  // the same split `ExamChat`'s identical attachment check already establishes.
  async function uploadDocument(file: File) {
    if (!selectedEntry) return;
    if (!ALLOWED_DOCUMENT_MIME_TYPES.includes(file.type)) {
      setDocumentError(t("nursing:documentTypeError"));
      return;
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      setDocumentError(t("nursing:documentSizeError"));
      return;
    }
    setDocumentError(null);
    setDocumentUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", documentKind);
      await api.postForm(`/queue/${selectedEntry.id}/documents`, form);
      await loadQueueAndSession(selectedEquipmentId);
    } catch (err) {
      setDocumentError(err instanceof ApiError ? err.message : t("nursing:documentUploadError"));
    } finally {
      setDocumentUploading(false);
    }
  }

  async function removeDocument(documentId: string) {
    if (!selectedEntry) return;
    setDocumentError(null);
    setRemovingDocumentId(documentId);
    try {
      await api.post(`/queue/${selectedEntry.id}/documents/${documentId}/remove`);
      await loadQueueAndSession(selectedEquipmentId);
    } catch (err) {
      setDocumentError(err instanceof ApiError ? err.message : t("nursing:documentRemoveError"));
    } finally {
      setRemovingDocumentId(null);
    }
  }

  // ------------------------------------------------------------------------------------
  // Per-exam timeline (right column)
  // ------------------------------------------------------------------------------------

  const [timeline, setTimeline] = useState<QueueTimelineEntry[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  // Bumped after any action that writes a new audit row for the selected entry (a details
  // save, a preparation quick-action). Without it the timeline only ever reloaded when
  // `selectedEntryId` itself changed, so the nurse's own just-saved edit was missing from
  // the panel until she clicked a different patient and back -- found by driving the real
  // screen in a browser, not by any type or contract check.
  const [timelineNonce, setTimelineNonce] = useState(0);

  useEffect(() => {
    if (!selectedEntryId) {
      setTimeline([]);
      return;
    }
    setTimelineLoading(true);
    setTimelineError(null);
    api
      .get<QueueTimelineEntry[]>(`/queue/${selectedEntryId}/timeline`)
      .then(setTimeline)
      .catch((err) => setTimelineError(err instanceof Error ? err.message : t("nursing:timelineLoadError")))
      .finally(() => setTimelineLoading(false));
  }, [selectedEntryId, timelineNonce, t]);

  const editFieldsDisabled = !selectedEntry || !isDetailsEditable(selectedEntry) || detailsSaving;
  const notInformed = t("nursing:notInformed");

  return (
    <ConsoleShell activeNav="nursing" pageTitle={t("nursing:heading")} wide>
      <h1 className="sr-only">{t("nursing:heading")}</h1>
      <div aria-live="polite" className="sr-only">
        {moveAnnouncement}
      </div>

      <Card className="mb-4 flex-row flex-wrap items-center justify-between gap-4 p-4">
        <div className="min-w-[220px]">
          <Label htmlFor="nursing-room-select" className="mb-1.5">
            {t("nursing:roomLabel")}
          </Label>
          {equipmentError && (
            <p className="text-sm text-destructive" role="alert">
              {equipmentError}
            </p>
          )}
          {equipmentList.length === 0 && !equipmentError ? (
            <p className="text-sm text-muted-foreground">{t("nursing:noEquipment")}</p>
          ) : (
            <Select
              value={selectedEquipmentId}
              onValueChange={(value) => {
                const next = new URLSearchParams(params);
                next.set("equipmentId", value);
                setParams(next, { replace: true });
              }}
            >
              <SelectTrigger id="nursing-room-select" className="w-56">
                <SelectValue placeholder={t("nursing:roomPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {equipmentList.map((equipment) => (
                  <SelectItem key={equipment.id} value={equipment.id}>
                    {equipment.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        {selectedEquipment && (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5 font-semibold">
              <MapPin className="size-4 text-muted-foreground" />
              {roomHeading}
            </div>
            {roomSubtitle && <span className="text-sm text-muted-foreground">{roomSubtitle}</span>}
          </div>
        )}
        {me && (
          <div className="ml-auto flex items-center gap-1.5 text-right text-sm">
            <User className="size-4 text-muted-foreground" />
            <span>
              {[me.firstName, me.lastName].filter(Boolean).join(" ") || me.email}
              {me.professionalRegistration && <span className="text-muted-foreground"> · {me.professionalRegistration}</span>}
            </span>
          </div>
        )}
      </Card>

      {loadError && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>
            {loadError}{" "}
            <button className="underline" onClick={() => void loadQueueAndSession(selectedEquipmentId)}>
              {t("nursing:retry")}
            </button>
          </AlertDescription>
        </Alert>
      )}

      {selectedEquipmentId && !loading && !loadError && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-4">
            {activeSession && (
              <Alert role="status" className="border-l-4 border-l-[#b8860b] bg-[#fdf6ec]">
                <Lock className="text-[#6b4a00]" />
                <AlertTitle className="text-[#6b4a00]">{t("nursing:lockBannerTitle")}</AlertTitle>
                <AlertDescription className="text-[#6b4a00]/90">
                  {activeSession.operatorName
                    ? t("nursing:lockBannerBodyKnownOperator", { operatorName: activeSession.operatorName })
                    : t("nursing:lockBannerBodyUnknownOperator")}
                </AlertDescription>
              </Alert>
            )}

            {staleQueueNotice && (
              <Alert variant="destructive">
                <RefreshCw />
                <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                  <span>{t("nursing:staleQueueNotice")}</span>
                  <Button variant="outline" size="sm" onClick={reloadDiscardingReorderDraft}>
                    {t("nursing:reloadQueue")}
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            {isReorderDirty && !staleQueueNotice && (
              <Alert role="status" className="border-l-4 border-l-[#b8860b] bg-[#fdf6ec]">
                <RefreshCw className="text-[#6b4a00]" />
                <AlertTitle className="text-[#6b4a00]">{t("nursing:reorderBannerTitle")}</AlertTitle>
                <AlertDescription className="text-[#6b4a00]/90">
                  <p className="mb-2">{t("nursing:reorderBannerBody", { count: draftOrder.length })}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={resetDraftToServerOrder} disabled={reorderSaving}>
                      {t("nursing:restoreOriginalOrder")}
                    </Button>
                    <Button variant="outline" size="sm" onClick={resetDraftToServerOrder} disabled={reorderSaving}>
                      {t("nursing:cancelChanges")}
                    </Button>
                    <Button size="sm" onClick={() => void confirmReorder()} disabled={reorderSaving}>
                      {reorderSaving && <Loader2 className="animate-spin" />}
                      {reorderSaving ? t("nursing:reorderSaving") : t("nursing:confirmNewSequence")}
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}
            {reorderError && (
              <Alert variant="destructive">
                <AlertDescription>{reorderError}</AlertDescription>
              </Alert>
            )}

            <Card className="p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold">{t("nursing:queueHeading", { count: queue.length })}</h2>
                <Button onClick={openNewExamModal}>
                  <Plus />
                  {t("nursing:newExamButton")}
                </Button>
              </div>
              {queue.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("nursing:queueEmpty")}</p>
              ) : (
                <ul className="flex list-none gap-3 overflow-x-auto p-0.5 m-0">
                  {displayQueue.map((entry, index) => {
                    const reorderable = isReorderable(entry);
                    const draftIndex = draftOrder.indexOf(entry.id);
                    const chip = queueCardChipOf(entry);
                    const selected = selectedEntryId === entry.id;
                    return (
                      <li
                        key={entry.id}
                        className={cn(
                          "flex w-56 flex-shrink-0 flex-col gap-2 rounded-lg border p-3",
                          reorderable && "cursor-grab",
                          draggingId === entry.id && "opacity-50",
                          dropTargetId === entry.id && "outline-2 outline-dashed outline-primary -outline-offset-2",
                          selected && "border-primary bg-accent"
                        )}
                        draggable={reorderable}
                        onDragStart={() => reorderable && setDraggingId(entry.id)}
                        onDragOver={(e) => {
                          if (!reorderable) return;
                          e.preventDefault();
                          setDropTargetId(entry.id);
                        }}
                        onDragLeave={() => setDropTargetId((current) => (current === entry.id ? null : current))}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (reorderable) onDropCard(entry.id);
                        }}
                        onDragEnd={() => {
                          setDraggingId(null);
                          setDropTargetId(null);
                        }}
                      >
                        <button
                          type="button"
                          className="flex flex-col items-start gap-1 text-left"
                          aria-current={selected ? "true" : undefined}
                          onClick={() => selectEntryForEditing(entry)}
                        >
                          <span className="text-xs font-medium text-muted-foreground">{t("nursing:cardRank", { position: index + 1 })}</span>
                          <span className="font-semibold">{entry.patientFirstName}</span>
                          {entry.examDescription && <span className="text-sm text-muted-foreground">{entry.examDescription}</span>}
                          {entry.scheduledAt && (
                            <span className="flex items-center gap-1 text-sm text-muted-foreground">
                              <Clock3 className="size-3.5" />
                              {formatClinicTime(entry.scheduledAt)}
                            </span>
                          )}
                          <Badge className={cn("border-transparent", chip.badgeClass)}>{t(chip.labelKey)}</Badge>
                        </button>
                        {reorderable && (
                          <div className="flex gap-1">
                            <Button
                              variant="outline"
                              size="icon-sm"
                              aria-label={t("nursing:moveUp", { patient: entry.patientFirstName })}
                              disabled={draftIndex <= 0}
                              onClick={() => moveDraft(entry.id, -1)}
                            >
                              <ChevronLeft />
                            </Button>
                            <Button
                              variant="outline"
                              size="icon-sm"
                              aria-label={t("nursing:moveDown", { patient: entry.patientFirstName })}
                              disabled={draftIndex < 0 || draftIndex >= draftOrder.length - 1}
                              onClick={() => moveDraft(entry.id, 1)}
                            >
                              <ChevronRight />
                            </Button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            <Card className="p-4">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold">{t("nursing:detailsHeading")}</h2>
                {selectedEntry && (
                  <div className="flex items-center gap-2">
                    {/* editMode checked first: editing the record doesn't itself change
                        preparationStatus, so a patient can be both "awaiting positioning"
                        and "being edited" at once -- editMode is the more actionable fact
                        of the two at that moment, so it wins the badge. */}
                    {editMode ? (
                      <Badge className="border-transparent bg-[#1d3a3d] text-[#6fe0dc]">
                        <Pencil className="size-3" />
                        {t("nursing:editModeBadge")}
                      </Badge>
                    ) : isAwaitingPositioning(selectedEntry) ? (
                      <Badge className="border-transparent bg-[#2a2a35] text-[#b8bfc9]">
                        <Clock3 className="size-3" />
                        {t("nursing:awaitingPositioningBadge")}
                      </Badge>
                    ) : (
                      <Badge variant="outline">
                        <Lock className="size-3" />
                        {t("nursing:readOnlyBadge")}
                      </Badge>
                    )}
                    {!editMode && (
                      <Button variant="secondary" size="sm" onClick={() => setEditMode(true)} disabled={!isDetailsEditable(selectedEntry)}>
                        <Pencil />
                        {t("nursing:enableEditing")}
                      </Button>
                    )}
                  </div>
                )}
              </div>
              <p className="mb-3 text-sm text-muted-foreground">{t("nursing:detailsSubheading")}</p>

              {!selectedEntry ? (
                <p className="text-sm text-muted-foreground">{t("nursing:detailsNoSelection")}</p>
              ) : (
                <>
                  {detailsStaleNotice && (
                    <Alert variant="destructive" className="mb-3">
                      <AlertDescription>
                        {t("nursing:detailsStaleNotice")}{" "}
                        <button className="underline" onClick={reloadDiscardingDetailsEdit}>
                          {t("nursing:reloadDetails")}
                        </button>
                      </AlertDescription>
                    </Alert>
                  )}
                  {!isDetailsEditable(selectedEntry) && (
                    <p className="mb-3 text-sm text-destructive">{t("nursing:detailsLockedNote")}</p>
                  )}
                  {detailsError && (
                    <Alert variant="destructive" className="mb-3">
                      <AlertDescription>{detailsError}</AlertDescription>
                    </Alert>
                  )}

                  {!editMode ? (
                    <div>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <SummaryField label={t("nursing:examDescriptionLabel")}>
                          <span className="font-semibold">{selectedEntry.examDescription || notInformed}</span>
                          <span className="text-xs text-muted-foreground">
                            {selectedEntry.contrastRequired
                              ? selectedEntry.contrastVolumeMl != null
                                ? t("nursing:contrastRequiredVolumeNote", { volume: selectedEntry.contrastVolumeMl })
                                : t("nursing:contrastRequiredNote")
                              : t("nursing:contrastNotRequiredNote")}
                          </span>
                        </SummaryField>
                        <SummaryField label={t("nursing:patientSexLabel")}>
                          <span className="font-semibold">
                            {selectedEntry.patientSex ? t(patientSexLabelKeyOf(selectedEntry.patientSex)) : notInformed}
                          </span>
                        </SummaryField>
                        <SummaryField label={t("nursing:patientWeightLabel")}>
                          <span className="font-semibold">
                            {selectedEntry.patientWeightKg != null ? `${selectedEntry.patientWeightKg} kg` : notInformed}
                          </span>
                        </SummaryField>
                      </div>

                      <h3 className="mt-5 mb-3 flex items-center gap-1.5 text-sm font-semibold">
                        <ListChecks className="size-4" />
                        {t("nursing:questionnaireHeading")}
                      </h3>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <SummaryField label={t("nursing:scheduledAtLabel")}>
                          <span className="font-semibold">
                            {selectedEntry.scheduledAt ? formatClinicTime(selectedEntry.scheduledAt) : notInformed}
                          </span>
                        </SummaryField>
                        <SummaryField label={t("nursing:fastingConfirmedLabel")}>
                          <span className="font-semibold">
                            {selectedEntry.fastingConfirmed
                              ? selectedEntry.fastingHours != null
                                ? t("nursing:fastingConfirmedHoursNote", { hours: selectedEntry.fastingHours })
                                : t("nursing:fastingConfirmedNote")
                              : t("nursing:fastingNotConfirmedNote")}
                          </span>
                        </SummaryField>
                        <SummaryField label={t("nursing:creatinineLabel")}>
                          <span className="font-semibold">
                            {selectedEntry.creatinineMgDl != null ? `${selectedEntry.creatinineMgDl} mg/dL` : notInformed}
                          </span>
                        </SummaryField>
                        <SummaryField label={t("nursing:allergyStatusLabel")}>
                          {selectedEntry.allergyStatus ? (
                            <Badge
                              className={cn(
                                "w-fit border-transparent",
                                selectedEntry.allergyStatus === AllergyStatus.PRESENT
                                  ? "bg-[#3d1d1d] text-[#ff8b8b]"
                                  : "bg-[#1d3d2b] text-[#5fdc8a]"
                              )}
                            >
                              {selectedEntry.allergyStatus === AllergyStatus.PRESENT ? (
                                <ShieldAlert className="size-3" />
                              ) : (
                                <ShieldCheck className="size-3" />
                              )}
                              {t(allergyStatusLabelKeyOf(selectedEntry.allergyStatus))}
                            </Badge>
                          ) : (
                            <span className="font-semibold">{notInformed}</span>
                          )}
                          {selectedEntry.allergyStatus === AllergyStatus.PRESENT && selectedEntry.allergyNotes && (
                            <span className="text-sm text-destructive">{selectedEntry.allergyNotes}</span>
                          )}
                        </SummaryField>
                        <SummaryField label={t("nursing:metforminUseLabel")}>
                          <span className="font-semibold">
                            {selectedEntry.metforminUse === null ? notInformed : selectedEntry.metforminUse ? t("nursing:yes") : t("nursing:no")}
                          </span>
                        </SummaryField>
                        <SummaryField label={t("nursing:anticoagulantUseLabel")}>
                          <span className="font-semibold">
                            {selectedEntry.anticoagulantUse === null
                              ? notInformed
                              : selectedEntry.anticoagulantUse
                                ? t("nursing:yes")
                                : t("nursing:no")}
                          </span>
                        </SummaryField>
                      </div>

                      <h3 className="mt-5 mb-2 text-sm font-semibold">{t("nursing:observationsHeading")}</h3>
                      <p className="text-sm">{selectedEntry.preparationNotes || t("nursing:noObservations")}</p>

                      {selectedEntry.detailsUpdatedAt && (
                        <p className="mt-3 text-sm text-muted-foreground">
                          {t("nursing:attributionLine", {
                            time: formatClinicTime(selectedEntry.detailsUpdatedAt),
                            name: selectedEntry.detailsUpdatedByName ?? t("nursing:attributionUnknown"),
                          })}
                        </p>
                      )}

                      {isAwaitingPositioning(selectedEntry) && (
                        <p className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
                          <Clock3 className="size-4" />
                          {t("nursing:awaitingConfirmationNote")}
                        </p>
                      )}
                    </div>
                  ) : (
                    <fieldset disabled={editFieldsDisabled} className="border-none p-0 m-0">
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="details-exam-description">{t("nursing:examDescriptionLabel")}</Label>
                          <Input
                            id="details-exam-description"
                            type="text"
                            placeholder={t("nursing:examDescriptionPlaceholder")}
                            value={detailsDraft.examDescription}
                            onChange={(e) => updateDraftField("examDescription", e.target.value)}
                          />
                          {detailsFieldErrors.examDescription && <p className="text-sm text-destructive">{detailsFieldErrors.examDescription}</p>}
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="details-patient-sex">{t("nursing:patientSexLabel")}</Label>
                          <Select
                            value={detailsDraft.patientSex ?? UNSET}
                            onValueChange={(value) => updateDraftField("patientSex", value === UNSET ? null : (value as PatientSex))}
                          >
                            <SelectTrigger id="details-patient-sex" className="w-full">
                              <SelectValue placeholder={t("nursing:patientSexPlaceholder")} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={UNSET}>{t("nursing:patientSexPlaceholder")}</SelectItem>
                              {Object.values(PatientSex).map((sex) => (
                                <SelectItem key={sex} value={sex}>
                                  {t(patientSexLabelKeyOf(sex))}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="details-weight">{t("nursing:patientWeightLabel")}</Label>
                          <Input
                            id="details-weight"
                            type="number"
                            min={1}
                            max={500}
                            value={detailsDraft.patientWeightKg ?? ""}
                            onChange={(e) => updateDraftField("patientWeightKg", e.target.value === "" ? null : Number(e.target.value))}
                          />
                          {detailsFieldErrors.patientWeightKg && <p className="text-sm text-destructive">{detailsFieldErrors.patientWeightKg}</p>}
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="details-scheduled-at">{t("nursing:scheduledAtLabel")}</Label>
                          <Input
                            id="details-scheduled-at"
                            type="time"
                            value={detailsDraft.scheduledAtTime}
                            onChange={(e) => updateDraftField("scheduledAtTime", e.target.value)}
                          />
                        </div>
                        <div className="flex items-end">
                          <Label className="flex items-center gap-2">
                            <Checkbox
                              checked={detailsDraft.contrastRequired}
                              onCheckedChange={(checked) => updateDraftField("contrastRequired", checked === true)}
                            />
                            {t("nursing:contrastRequiredLabel")}
                          </Label>
                        </div>
                        {detailsDraft.contrastRequired && (
                          <div className="flex flex-col gap-1.5">
                            <Label htmlFor="details-contrast-volume">{t("nursing:contrastVolumeLabel")}</Label>
                            <Input
                              id="details-contrast-volume"
                              type="number"
                              min={0}
                              max={500}
                              value={detailsDraft.contrastVolumeMl ?? ""}
                              onChange={(e) => updateDraftField("contrastVolumeMl", e.target.value === "" ? null : Number(e.target.value))}
                            />
                            {detailsFieldErrors.contrastVolumeMl && (
                              <p className="text-sm text-destructive">{detailsFieldErrors.contrastVolumeMl}</p>
                            )}
                          </div>
                        )}
                      </div>

                      <h3 className="mt-5 mb-3 flex items-center gap-1.5 text-sm font-semibold">
                        <ListChecks className="size-4" />
                        {t("nursing:questionnaireHeading")}
                      </h3>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        <div className="flex items-end">
                          <Label className="flex items-center gap-2">
                            <Checkbox
                              checked={detailsDraft.fastingConfirmed}
                              onCheckedChange={(checked) => updateDraftField("fastingConfirmed", checked === true)}
                            />
                            {t("nursing:fastingConfirmedLabel")}
                          </Label>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="details-fasting-hours">{t("nursing:fastingHoursLabel")}</Label>
                          <Input
                            id="details-fasting-hours"
                            type="number"
                            min={0}
                            max={72}
                            value={detailsDraft.fastingHours ?? ""}
                            onChange={(e) => updateDraftField("fastingHours", e.target.value === "" ? null : Number(e.target.value))}
                          />
                          {detailsFieldErrors.fastingHours && <p className="text-sm text-destructive">{detailsFieldErrors.fastingHours}</p>}
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="details-creatinine">{t("nursing:creatinineLabel")}</Label>
                          <Input
                            id="details-creatinine"
                            type="number"
                            min={0}
                            max={20}
                            step="0.1"
                            value={detailsDraft.creatinineMgDl ?? ""}
                            onChange={(e) => updateDraftField("creatinineMgDl", e.target.value === "" ? null : Number(e.target.value))}
                          />
                          {detailsFieldErrors.creatinineMgDl && <p className="text-sm text-destructive">{detailsFieldErrors.creatinineMgDl}</p>}
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="details-allergy-status">{t("nursing:allergyStatusLabel")}</Label>
                          <Select
                            value={detailsDraft.allergyStatus ?? UNSET}
                            onValueChange={(value) => updateDraftField("allergyStatus", value === UNSET ? null : (value as AllergyStatus))}
                          >
                            <SelectTrigger id="details-allergy-status" className="w-full">
                              <SelectValue placeholder={t("nursing:allergyStatusPlaceholder")} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={UNSET}>{t("nursing:allergyStatusPlaceholder")}</SelectItem>
                              <SelectItem value={AllergyStatus.NEGATED}>{t(allergyStatusLabelKeyOf(AllergyStatus.NEGATED))}</SelectItem>
                              <SelectItem value={AllergyStatus.PRESENT}>{t(allergyStatusLabelKeyOf(AllergyStatus.PRESENT))}</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="details-metformin-use">{t("nursing:metforminUseLabel")}</Label>
                          <Select
                            value={boolToSelectValue(detailsDraft.metforminUse)}
                            onValueChange={(value) => updateDraftField("metforminUse", selectValueToBool(value))}
                          >
                            <SelectTrigger id="details-metformin-use" className="w-full">
                              <SelectValue placeholder={t("nursing:triStatePlaceholder")} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={UNSET}>{t("nursing:triStatePlaceholder")}</SelectItem>
                              <SelectItem value="true">{t("nursing:yes")}</SelectItem>
                              <SelectItem value="false">{t("nursing:no")}</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="details-anticoagulant-use">{t("nursing:anticoagulantUseLabel")}</Label>
                          <Select
                            value={boolToSelectValue(detailsDraft.anticoagulantUse)}
                            onValueChange={(value) => updateDraftField("anticoagulantUse", selectValueToBool(value))}
                          >
                            <SelectTrigger id="details-anticoagulant-use" className="w-full">
                              <SelectValue placeholder={t("nursing:triStatePlaceholder")} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={UNSET}>{t("nursing:triStatePlaceholder")}</SelectItem>
                              <SelectItem value="true">{t("nursing:yes")}</SelectItem>
                              <SelectItem value="false">{t("nursing:no")}</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      {detailsDraft.allergyStatus === AllergyStatus.PRESENT && (
                        <div className="mt-4 flex flex-col gap-1.5">
                          <Label htmlFor="details-allergy-notes">{t("nursing:allergyNotesLabel")}</Label>
                          <Textarea
                            id="details-allergy-notes"
                            rows={2}
                            value={detailsDraft.allergyNotes}
                            onChange={(e) => updateDraftField("allergyNotes", e.target.value)}
                          />
                          {detailsFieldErrors.allergyNotes && <p className="text-sm text-destructive">{detailsFieldErrors.allergyNotes}</p>}
                        </div>
                      )}

                      <div className="mt-4 flex flex-col gap-1.5">
                        <Label htmlFor="details-notes">{t("nursing:preparationNotesLabel")}</Label>
                        <Textarea
                          id="details-notes"
                          rows={4}
                          placeholder={t("nursing:preparationNotesPlaceholder")}
                          value={detailsDraft.preparationNotes}
                          onChange={(e) => updateDraftField("preparationNotes", e.target.value)}
                        />
                        {detailsFieldErrors.preparationNotes && <p className="text-sm text-destructive">{detailsFieldErrors.preparationNotes}</p>}
                      </div>
                    </fieldset>
                  )}

                  {/* Documentação do Exame -- shown in both read-only and edit mode (unlike
                      every field above, which only edits inside the fieldset): upload/remove
                      is its own immediate route, not part of this card's own draft/dirty
                      lifecycle, so it has no reason to be hidden behind "Habilitar Edição". */}
                  <div className="mt-5 border-t pt-4">
                    <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                      <FileText className="size-4" />
                      {t("nursing:documentsHeading")}
                    </h3>
                    <p className="mb-3 text-xs text-muted-foreground">{t("nursing:documentsSubheading")}</p>

                    {documentError && (
                      <Alert variant="destructive" className="mb-3">
                        <AlertDescription>{documentError}</AlertDescription>
                      </Alert>
                    )}

                    {selectedEntry.documents.length > 0 && (
                      <ul className="mb-3 flex flex-col gap-1.5">
                        {selectedEntry.documents.map((document) => (
                          <QueueDocumentRow
                            key={document.id}
                            queueEntryId={selectedEntry.id}
                            document={document}
                            onRemove={() => void removeDocument(document.id)}
                            removing={removingDocumentId === document.id}
                            canRemove={isDetailsEditable(selectedEntry)}
                          />
                        ))}
                      </ul>
                    )}

                    {isDetailsEditable(selectedEntry) ? (
                      <>
                        <div className="mb-2 flex flex-col gap-1.5 sm:max-w-64">
                          <Label htmlFor="document-kind">{t("nursing:documentKindLabel")}</Label>
                          <Select value={documentKind} onValueChange={(value) => setDocumentKind(value as QueueDocumentKind)}>
                            <SelectTrigger id="document-kind" className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {Object.values(QueueDocumentKind).map((kind) => (
                                <SelectItem key={kind} value={kind}>
                                  {t(DOCUMENT_KIND_LABEL_KEY[kind])}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <FileDropzone
                          accept={ALLOWED_DOCUMENT_MIME_TYPES.join(",")}
                          busy={documentUploading}
                          onFileSelected={(file) => void uploadDocument(file)}
                          label={t("nursing:documentDropzoneLabel")}
                          hint={t("nursing:documentDropzoneHint")}
                          browseLabel={t("nursing:documentBrowseLabel")}
                        />
                        {/* Immediate, not staged -- see uploadDocument/removeDocument's own
                            docstrings. Said explicitly rather than left implicit, since every
                            *other* control on this card right now (metforminUse included)
                            waits for "Salvar Alterações deste Paciente". */}
                        <p className="mt-2 text-xs text-muted-foreground">{t("nursing:documentsImmediateNote")}</p>
                      </>
                    ) : (
                      selectedEntry.documents.length === 0 && <p className="text-sm text-muted-foreground">{t("nursing:documentsEmpty")}</p>
                    )}
                  </div>

                  {editMode && selectedEntry.detailsUpdatedAt && (
                    <p className="mt-3 text-sm text-muted-foreground">
                      {t("nursing:attributionLine", {
                        time: formatClinicTime(selectedEntry.detailsUpdatedAt),
                        name: selectedEntry.detailsUpdatedByName ?? t("nursing:attributionUnknown"),
                      })}
                    </p>
                  )}

                  {editMode && (
                    <div className="mt-4 flex gap-2.5">
                      <Button variant="outline" onClick={discardDetailsEdit} disabled={!detailsDirty || detailsSaving}>
                        {t("nursing:discardDetails")}
                      </Button>
                      <Button
                        onClick={() => void saveDetails()}
                        disabled={!detailsDirty || detailsSaving || !isDetailsEditable(selectedEntry)}
                      >
                        {detailsSaving && <Loader2 className="animate-spin" />}
                        {detailsSaving ? t("nursing:detailsSaving") : t("nursing:saveDetails")}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </Card>

            <Card className="p-4">
              <h2 className="mb-1 text-base font-semibold">{t("nursing:actionsHeading")}</h2>
              <p className="mb-3 text-sm text-muted-foreground">{t("nursing:actionsSubheading")}</p>
              {actionError && (
                <Alert variant="destructive" className="mb-3">
                  <AlertDescription>{actionError}</AlertDescription>
                </Alert>
              )}
              {!currentPatient ? (
                <p className="text-sm text-muted-foreground">{t("nursing:noCurrentPatient")}</p>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <PrepStep
                    label={t("nursing:stepPositioned")}
                    icon={<UserCheck />}
                    doneAt={currentPatient.positionedAt}
                    actionable={availablePreparationActions(currentPatient.preparationStatus).includes(PreparationStatus.POSITIONED)}
                    busy={actionEntryId === currentPatient.id}
                    onAct={() => updatePreparation(currentPatient.id, PreparationStatus.POSITIONED)}
                    t={t}
                  />
                  <PrepStep
                    label={t("nursing:stepInjected")}
                    icon={<Syringe />}
                    doneAt={currentPatient.injectedAt}
                    skipped={!currentPatient.injectedAt && !!currentPatient.releasedAt}
                    actionable={availablePreparationActions(currentPatient.preparationStatus).includes(PreparationStatus.INJECTED)}
                    busy={actionEntryId === currentPatient.id}
                    onAct={() => updatePreparation(currentPatient.id, PreparationStatus.INJECTED)}
                    t={t}
                  />
                  <PrepStep
                    label={t("nursing:stepReleased")}
                    icon={<LogOut />}
                    doneAt={currentPatient.releasedAt}
                    actionable={
                      availablePreparationActions(currentPatient.preparationStatus).includes(PreparationStatus.RELEASED) &&
                      !releaseBlockedByActiveSession(currentPatient)
                    }
                    blockedReason={releaseBlockedByActiveSession(currentPatient) ? t("nursing:stepBlockedBySession") : undefined}
                    busy={actionEntryId === currentPatient.id}
                    onAct={() => updatePreparation(currentPatient.id, PreparationStatus.RELEASED)}
                    t={t}
                  />
                </div>
              )}
            </Card>
          </div>

          <div className="flex flex-col gap-4">
            <Card className="p-4">
              <h2 className="mb-1 flex items-center gap-1.5 text-base font-semibold">
                <Wifi className="size-4" />
                {t("nursing:operatorCardHeading")}
              </h2>
              {activeSession ? (
                <>
                  <p className="font-semibold">{activeSession.operatorName ?? t("nursing:attributionUnknown")}</p>
                  {activeSession.operatorRegistration && (
                    <p className="text-sm text-muted-foreground">{activeSession.operatorRegistration}</p>
                  )}
                  <Badge className="mt-2 w-fit border-transparent bg-[#1d3d2b] text-[#5fdc8a]">{t("nursing:operatorOnlineBadge")}</Badge>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{t("nursing:operatorCardNone")}</p>
              )}
            </Card>

            <Card className="flex min-h-100 flex-1 flex-col p-4">
              <h2 className="mb-1 flex items-center gap-1.5 text-base font-semibold">
                <MessageCircle className="size-4" />
                {t("nursing:chatHeading")}
              </h2>
              <div className="flex flex-1 min-h-0 flex-col pt-1">
                <ExamChat
                  messages={chatMessages}
                  shortcuts={chatShortcuts}
                  currentUserId={me?.id}
                  onSend={sendChatMessage}
                  onCreateShortcut={createChatShortcut}
                  creatingShortcut={creatingShortcut}
                  createShortcutError={createShortcutError}
                  day={chatDay}
                  onDayChange={setChatDay}
                  loadError={chatLoadError}
                />
              </div>
            </Card>

            <Card className="p-4">
              <h2 className="mb-1 flex items-center gap-1.5 text-base font-semibold">
                <History className="size-4" />
                {t("nursing:timelineHeading")}
              </h2>
              {!selectedEntry ? (
                <p className="text-sm text-muted-foreground">{t("nursing:timelineNoSelection")}</p>
              ) : timelineLoading ? (
                <p aria-live="polite" className="text-sm text-muted-foreground">
                  {t("nursing:loading")}
                </p>
              ) : timelineError ? (
                <Alert variant="destructive">
                  <AlertDescription>{timelineError}</AlertDescription>
                </Alert>
              ) : timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("nursing:timelineEmpty")}</p>
              ) : (
                <ul className="flex flex-col gap-2 list-none p-0 m-0">
                  {timeline.map((entry, index) => {
                    const labelKey = timelineActionLabelKeyOf(entry);
                    return (
                      <li key={`${entry.timestamp}-${index}`} className="border-l-2 pl-2 text-sm">
                        <span className="font-semibold">{formatClinicTime(entry.timestamp)}</span>{" "}
                        <span>{labelKey ? t(labelKey) : entry.action}</span>
                        {entry.actorName && <span className="text-muted-foreground"> · {entry.actorName}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}

      {selectedEquipmentId && loading && (
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {t("nursing:loading")}
        </p>
      )}

      {newExamOpen && (
        <Modal title={t("nursing:newExamModalTitle")} onClose={() => setNewExamOpen(false)} returnFocusTo={newExamTriggerRef.current}>
          <div className="flex flex-col gap-4">
            {newExamError && (
              <Alert variant="destructive">
                <AlertDescription>{newExamError}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-exam-name">{t("nursing:newExamPatientNameLabel")}</Label>
              <Input id="new-exam-name" type="text" value={newExamName} onChange={(e) => setNewExamName(e.target.value)} autoFocus />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-exam-time">{t("nursing:newExamScheduledTimeLabel")}</Label>
              <Input id="new-exam-time" type="time" value={newExamTime} onChange={(e) => setNewExamTime(e.target.value)} />
            </div>
            <div className="flex gap-2.5">
              <Button variant="outline" onClick={() => setNewExamOpen(false)} disabled={newExamSaving}>
                {t("nursing:newExamCancel")}
              </Button>
              <Button onClick={() => void submitNewExam()} disabled={newExamSaving}>
                {newExamSaving && <Loader2 className="animate-spin" />}
                {newExamSaving ? t("nursing:detailsSaving") : t("nursing:newExamSubmit")}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </ConsoleShell>
  );
}

/** A dumb `label` + `value(s)` stack for the read-only summary view -- the display-only
 * counterpart to a `<div className="field">`, used only in that branch. */
function SummaryField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
      {children}
    </div>
  );
}

/** `kind` i18n keys -- a literal mapping, not an assembled template, same "keep tsc checking
 * every key against pt-BR.ts's real shape" reasoning `statusLabelKeyOf`/`queueStatusLabelKeyOf`
 * already establish in equipment-display.ts/queue-display.ts. */
const DOCUMENT_KIND_LABEL_KEY: Record<QueueDocumentKind, "nursing:documentKindPedidoMedico" | "nursing:documentKindLaudoAnterior" | "nursing:documentKindOutro"> = {
  [QueueDocumentKind.PEDIDO_MEDICO]: "nursing:documentKindPedidoMedico",
  [QueueDocumentKind.LAUDO_ANTERIOR]: "nursing:documentKindLaudoAnterior",
  [QueueDocumentKind.OUTRO]: "nursing:documentKindOutro",
};

/** One uploaded document, rendered as a click-to-download chip -- same `api.getBlob` + blob
 * + `<a download>` shape `ExamChat`'s own `ChatAttachment` already uses, for the identical
 * reason: the content route is authenticated, so a bare `<a href>` cannot carry the
 * Authorization header this needs. Own per-row `downloading` state, not a shared one keyed
 * by id, mirroring `ChatAttachment`'s own choice -- there is one of these per document, not
 * one for the whole list. */
function QueueDocumentRow({
  queueEntryId,
  document,
  onRemove,
  removing,
  canRemove,
}: {
  queueEntryId: string;
  document: QueueEntryDocumentDto;
  onRemove: () => void;
  removing: boolean;
  canRemove: boolean;
}) {
  const { t } = useTranslation(["nursing"]);
  const [downloading, setDownloading] = useState(false);
  const path = `/queue/${queueEntryId}/documents/${document.id}/content`;

  async function download() {
    setDownloading(true);
    try {
      const blob = await api.getBlob(path);
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
    <li className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-2 text-sm">
      <FileText className="size-4 flex-shrink-0 text-muted-foreground" />
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:opacity-60"
        onClick={() => void download()}
        disabled={downloading}
      >
        <span className="truncate font-medium">{document.filename}</span>
        <span className="flex-shrink-0 text-xs text-muted-foreground">({humanFileSize(document.sizeBytes)})</span>
        <Download className="size-3.5 flex-shrink-0 text-muted-foreground" aria-label={t("nursing:downloadDocument")} />
      </button>
      <Badge variant="outline" className="flex-shrink-0 text-[11px]">
        {t(DOCUMENT_KIND_LABEL_KEY[document.kind])}
      </Badge>
      <span className="flex-shrink-0 text-xs text-muted-foreground">
        {t("nursing:documentUploadedBy", { name: document.uploadedByName ?? t("nursing:attributionUnknown"), time: formatClinicTime(document.uploadedAt) })}
      </span>
      {canRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="flex-shrink-0 text-destructive hover:text-destructive"
          onClick={onRemove}
          disabled={removing}
          aria-label={t("nursing:removeDocument")}
        >
          {removing ? <Loader2 className="animate-spin" /> : <Trash2 />}
        </Button>
      )}
    </li>
  );
}


/** Sentinel for a Radix `Select.Item`'s `value` -- Radix rejects an empty string there (it's
 * reserved to mean "no selection" internally), but `patientSex`/`allergyStatus` are real
 * nullable fields the nurse must be able to clear back to "não informado". Mapped to/from
 * `null` at the read/write boundary in `onValueChange`/the controlled `value` prop; never
 * sent to the API (the PATCH body always reads the underlying `DetailsDraft` field, never
 * this constant). */
const UNSET = "__unset__";

/** Soft client-side mirror of the server's own `QUEUE_DOCUMENT_MAX_BYTES` default (20MB) --
 * same "the client check is a UX nicety, not the real gate" relationship `ExamChat`'s own
 * `MAX_ATTACHMENT_BYTES` has to `CHAT_ATTACHMENT_MAX_BYTES`. */
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** `metforminUse`/`anticoagulantUse` are tri-state (`boolean | null`), not the two-state
 * `Checkbox` the rest of this form's yes/no questions use -- same reasoning as
 * `allergyStatus`'s own `Select`+`UNSET` pattern, which this mirrors exactly rather than
 * inventing a second way to represent "not asked yet" as a string. */
function boolToSelectValue(value: boolean | null): string {
  return value === null ? UNSET : value ? "true" : "false";
}
function selectValueToBool(value: string): boolean | null {
  return value === UNSET ? null : value === "true";
}



interface DetailsDraft {
  examDescription: string;
  contrastRequired: boolean;
  patientSex: PatientSex | null;
  patientWeightKg: number | null;
  // Only the time-of-day portion is editable here -- the exam is always "today" from the
  // nurse's own screen (this page shows no other day); combined with `today` through
  // `clinicTimeToUtcIso`/`formatClinicTime` (see clinic-day.ts) rather than a bare UTC
  // construction, which is the bug this pass fixes.
  scheduledAtTime: string;
  preparationNotes: string;
  fastingConfirmed: boolean;
  fastingHours: number | null;
  creatinineMgDl: number | null;
  allergyStatus: AllergyStatus | null;
  allergyNotes: string;
  contrastVolumeMl: number | null;
  // Tri-state like allergyStatus above (not two-state like fastingConfirmed/contrastRequired):
  // "not asked yet" and "asked, answered no" are different states, so these are rendered as
  // a Select with the same UNSET sentinel, not a Checkbox.
  metforminUse: boolean | null;
  anticoagulantUse: boolean | null;
}

function emptyDetailsDraft(): DetailsDraft {
  return {
    examDescription: "",
    contrastRequired: false,
    patientSex: null,
    patientWeightKg: null,
    scheduledAtTime: "",
    preparationNotes: "",
    fastingConfirmed: false,
    fastingHours: null,
    creatinineMgDl: null,
    allergyStatus: null,
    allergyNotes: "",
    contrastVolumeMl: null,
    metforminUse: null,
    anticoagulantUse: null,
  };
}

function draftFromEntry(entry: QueueEntryDto): DetailsDraft {
  return {
    examDescription: entry.examDescription ?? "",
    contrastRequired: entry.contrastRequired,
    patientSex: entry.patientSex,
    patientWeightKg: entry.patientWeightKg,
    scheduledAtTime: entry.scheduledAt ? formatClinicTime(entry.scheduledAt) : "",
    preparationNotes: entry.preparationNotes ?? "",
    fastingConfirmed: entry.fastingConfirmed,
    fastingHours: entry.fastingHours,
    creatinineMgDl: entry.creatinineMgDl,
    allergyStatus: entry.allergyStatus,
    allergyNotes: entry.allergyNotes ?? "",
    contrastVolumeMl: entry.contrastVolumeMl,
    metforminUse: entry.metforminUse,
    anticoagulantUse: entry.anticoagulantUse,
  };
}

/** Whether the fields this form actually edits changed on the server -- deliberately not a
 * whole-object comparison (position/status changing doesn't matter to this form). */
function hasDetailsChanged(previous: QueueEntryDto, next: QueueEntryDto): boolean {
  return (
    previous.examDescription !== next.examDescription ||
    previous.contrastRequired !== next.contrastRequired ||
    previous.patientSex !== next.patientSex ||
    previous.patientWeightKg !== next.patientWeightKg ||
    previous.scheduledAt !== next.scheduledAt ||
    previous.preparationNotes !== next.preparationNotes ||
    previous.fastingConfirmed !== next.fastingConfirmed ||
    previous.fastingHours !== next.fastingHours ||
    previous.creatinineMgDl !== next.creatinineMgDl ||
    previous.allergyStatus !== next.allergyStatus ||
    previous.allergyNotes !== next.allergyNotes ||
    previous.contrastVolumeMl !== next.contrastVolumeMl ||
    previous.metforminUse !== next.metforminUse ||
    previous.anticoagulantUse !== next.anticoagulantUse
  );
}

/** Every field goes in the PATCH body -- UpdateQueueEntryDetailsRequestSchema treats
 * "undefined = leave alone" as the no-op case, but this form always shows the entry's full
 * current state, so a save always means "set every one of these to exactly what's on
 * screen," never a sparse patch. Empty string -> null (cleared), matching the schema's own
 * nullish convention. `scheduledAtTime` goes through `clinicTimeToUtcIso` (today's clinic
 * day + this wall-clock time), not a bare UTC construction -- see this file's own docstring
 * on the bug that fixes. */
function detailsDraftToPatchBody(draft: DetailsDraft, today: string): Record<string, unknown> {
  return {
    examDescription: draft.examDescription.trim() === "" ? null : draft.examDescription.trim(),
    contrastRequired: draft.contrastRequired,
    patientSex: draft.patientSex,
    patientWeightKg: draft.patientWeightKg,
    scheduledAt: draft.scheduledAtTime ? clinicTimeToUtcIso(today, draft.scheduledAtTime) : null,
    preparationNotes: draft.preparationNotes.trim() === "" ? null : draft.preparationNotes.trim(),
    fastingConfirmed: draft.fastingConfirmed,
    fastingHours: draft.fastingHours,
    creatinineMgDl: draft.creatinineMgDl,
    allergyStatus: draft.allergyStatus,
    allergyNotes: draft.allergyNotes.trim() === "" ? null : draft.allergyNotes.trim(),
    contrastVolumeMl: draft.contrastVolumeMl,
    metforminUse: draft.metforminUse,
    anticoagulantUse: draft.anticoagulantUse,
  };
}

function PrepStep({
  label,
  icon,
  doneAt,
  skipped,
  actionable,
  blockedReason,
  busy,
  onAct,
  t,
}: {
  label: string;
  icon: React.ReactNode;
  doneAt: string | null;
  skipped?: boolean;
  actionable: boolean;
  blockedReason?: string;
  busy: boolean;
  onAct: () => void;
  t: TFunction<["nursing"]>;
}) {
  const done = !!doneAt;
  return (
    <div className={cn("rounded-lg border p-3", done && "border-[#5fdc8a] bg-accent")}>
      <div className="mb-2 flex items-center gap-1.5 font-semibold">
        {icon}
        {label}
      </div>
      {done ? (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {/* `#166534` (Tailwind's own green-800), not `#5fdc8a` (the dark-theme badges'
              own green) -- that one is only ever paired with its own dark background
              (`#1d3d2b`, a self-contained pill); as plain text on this app's light `Card`
              background it measured 1.73:1, then a first replacement guess (`#3a9d5f`)
              still only 3.4:1 -- both caught by axe, not eyeballed. `#166534` is 7.13:1
              against white, verified by computing the real WCAG relative-luminance
              formula, not picked by eye. Same color at every "success/done" text spot on a
              light background in this app (AuditPage's PASS line, AdminUsersPage's
              "Convite enviado."). */}
          <CheckCircle2 className="size-4 text-[#166534]" />
          {t("nursing:stepDoneAt", { time: formatClinicTime(doneAt!) })}
        </p>
      ) : skipped ? (
        <p className="text-sm text-muted-foreground">{t("nursing:prepNotStarted")}</p>
      ) : actionable ? (
        <Button className="w-full" disabled={busy} onClick={onAct}>
          {busy ? <Loader2 className="animate-spin" /> : icon}
          {label}
        </Button>
      ) : (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {blockedReason && <AlertTriangle className="size-4" />}
          {blockedReason ?? t("nursing:prepNotStarted")}
        </p>
      )}
    </div>
  );
}
