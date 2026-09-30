import { AllergyStatus, PatientSex, PreparationStatus, QueueStatus, type QueueEntryDto, type QueueTimelineEntry } from "@crop/shared";

/**
 * Display helpers for `QueueEntryDto`, shared by `NursingPage` (the nurse's quick-action
 * screen) and `DashboardPage`'s own per-room queue table -- mirrors `equipment-display.ts`'s
 * role for `EquipmentDto`.
 */

export type QueueStatusLabelKey =
  | "nursing:queueStatusWaiting"
  | "nursing:queueStatusInProgress"
  | "nursing:queueStatusDone"
  | "nursing:queueStatusCancelled";

/** Fully-qualified translation keys, as a literal union rather than an assembled template --
 * same reasoning as `statusLabelKeyOf` in equipment-display.ts: this keeps `tsc` checking
 * every key against `pt-BR.ts`'s real shape. */
export function queueStatusLabelKeyOf(status: QueueStatus): QueueStatusLabelKey {
  const byStatus: Record<QueueStatus, QueueStatusLabelKey> = {
    [QueueStatus.WAITING]: "nursing:queueStatusWaiting",
    [QueueStatus.IN_PROGRESS]: "nursing:queueStatusInProgress",
    [QueueStatus.DONE]: "nursing:queueStatusDone",
    [QueueStatus.CANCELLED]: "nursing:queueStatusCancelled",
  };
  return byStatus[status];
}

/** Self-contained pill classes (own bg + fg, ported verbatim from the old `.badge.queue-*`
 * rules in styles.css) -- distinct pairs from the equipment badges' (`online`/`offline`/...)
 * so the two status vocabularies never collide if a future page renders both in the same DOM
 * subtree. Meant to be passed to shadcn's `Badge` alongside `border-transparent`, the same
 * convention `tailwindBadgeClassOf` (equipment-display.ts) established. */
export function queueStatusBadgeClass(status: QueueStatus): string {
  const byStatus: Record<QueueStatus, string> = {
    [QueueStatus.WAITING]: "bg-[#2a2a35] text-[#b8bfc9]",
    [QueueStatus.IN_PROGRESS]: "bg-[#3d2a1d] text-[#ffb366]",
    [QueueStatus.DONE]: "bg-[#1d3d2b] text-[#5fdc8a]",
    [QueueStatus.CANCELLED]: "bg-[#3d1d1d] text-[#ff8b8b]",
  };
  return byStatus[status];
}

export type PreparationStatusLabelKey =
  | "nursing:prepNotStarted"
  | "nursing:prepPositioned"
  | "nursing:prepInjected"
  | "nursing:prepReleased";

export function preparationStatusLabelKeyOf(status: PreparationStatus): PreparationStatusLabelKey {
  const byStatus: Record<PreparationStatus, PreparationStatusLabelKey> = {
    [PreparationStatus.NOT_STARTED]: "nursing:prepNotStarted",
    [PreparationStatus.POSITIONED]: "nursing:prepPositioned",
    [PreparationStatus.INJECTED]: "nursing:prepInjected",
    [PreparationStatus.RELEASED]: "nursing:prepReleased",
  };
  return byStatus[status];
}

export function preparationStatusBadgeClass(status: PreparationStatus): string {
  const byStatus: Record<PreparationStatus, string> = {
    [PreparationStatus.NOT_STARTED]: "bg-[#2a2a35] text-[#b8bfc9]",
    [PreparationStatus.POSITIONED]: "bg-[#1d2f3d] text-[#6fb1ff]",
    [PreparationStatus.INJECTED]: "bg-[#1d3a3d] text-[#6fe0dc]",
    [PreparationStatus.RELEASED]: "bg-[#1d3d2b] text-[#5fdc8a]",
  };
  return byStatus[status];
}

/**
 * The patient the nurse's "Ações Rápidas" panel acts on: whoever is currently `IN_PROGRESS`
 * (a session is running against them), else the first `WAITING` entry -- same precedence
 * `DashboardPage` already uses to pick `nextPatient` for "Start session". `DONE`/`CANCELLED`
 * entries are never a candidate; there is nothing left to do for them here.
 */
export function currentPatientOf(queue: readonly QueueEntryDto[]): QueueEntryDto | undefined {
  return queue.find((entry) => entry.status === QueueStatus.IN_PROGRESS) ?? queue.find((entry) => entry.status === QueueStatus.WAITING);
}

/**
 * Mirrors `QueueEntry.assertCanTransitionPreparationTo`'s `VALID_PREPARATION_TRANSITIONS` in
 * apps/api -- client-side only for enabling/disabling the right buttons immediately; the
 * server re-checks this regardless (see that guard's own docstring on why INJECTED is
 * skippable). Kept as a literal switch, not imported from the API, since apps/web has no
 * dependency on apps/api's domain layer.
 */
export function availablePreparationActions(status: PreparationStatus): readonly PreparationStatus[] {
  switch (status) {
    case PreparationStatus.NOT_STARTED:
      return [PreparationStatus.POSITIONED];
    case PreparationStatus.POSITIONED:
      return [PreparationStatus.INJECTED, PreparationStatus.RELEASED];
    case PreparationStatus.INJECTED:
      return [PreparationStatus.RELEASED];
    case PreparationStatus.RELEASED:
      return [];
  }
}

/**
 * The nurse's editable exam-detail fields (see the queue-reorder/exam-details feature) --
 * added alongside the reorder capability below, same "literal union, not a template type"
 * rule as every other label-key map in this file.
 */
export type PatientSexLabelKey = "nursing:patientSexFemale" | "nursing:patientSexMale" | "nursing:patientSexOther";

export function patientSexLabelKeyOf(sex: PatientSex): PatientSexLabelKey {
  const bySex: Record<PatientSex, PatientSexLabelKey> = {
    [PatientSex.FEMALE]: "nursing:patientSexFemale",
    [PatientSex.MALE]: "nursing:patientSexMale",
    [PatientSex.OTHER]: "nursing:patientSexOther",
  };
  return bySex[sex];
}

/**
 * Only WAITING entries ever participate in a reorder (see planQueueReorder in apps/api,
 * this is the client-side mirror of the same rule) -- an entry already IN_PROGRESS is on
 * the table, and DONE/CANCELLED is finished history, neither has a "priority" left to
 * reorder.
 */
export function isReorderable(entry: QueueEntryDto): boolean {
  return entry.status === QueueStatus.WAITING;
}

/**
 * Mirrors QueueEntry.assertDetailsEditable in apps/api: a DONE/CANCELLED entry's exam
 * details are locked, client-side, before the nurse ever gets a 409 back for trying.
 */
export function isDetailsEditable(entry: QueueEntryDto): boolean {
  return entry.status === QueueStatus.WAITING || entry.status === QueueStatus.IN_PROGRESS;
}

/**
 * "Awaiting Positioning" (the "Detalhes do Exame" card's read-only-summary trigger
 * condition -- see NursingPage's own docstring) is not a distinct state anywhere in this
 * codebase -- there is no `AWAITING_POSITIONING` value, and none is being added.
 * `PreparationStatus.NOT_STARTED` *is* that state: `VALID_PREPARATION_TRANSITIONS`
 * in `queue-entry.entity.ts` only ever leads a patient *out* of `NOT_STARTED` (into
 * `POSITIONED`), never back into it, so "not yet positioned" and "NOT_STARTED" are the same
 * fact under two names. This predicate exists only to give that fact an honest, self-
 * documenting call site rather than repeating the enum comparison inline -- it is
 * deliberately not a new label-key, badge class, or PreparationStatus member:
 * `nursing:prepNotStarted` ("Não iniciado") stays exactly as-is for the queue strip's own
 * chip, and the details card renders its own contextual "Aguardando Posicionamento" wording
 * (`nursing:awaitingPositioningBadge`) as a separate, card-scoped i18n key instead of
 * renaming that shared one.
 *
 * Scoped to WAITING/IN_PROGRESS for the same reason `isDetailsEditable` is: a DONE/
 * CANCELLED entry that happens to still read NOT_STARTED (skipped entirely, e.g. a
 * cancellation before any prep began) is finished history, not something actively awaiting
 * anything.
 */
export function isAwaitingPositioning(entry: QueueEntryDto): boolean {
  return (
    entry.preparationStatus === PreparationStatus.NOT_STARTED &&
    (entry.status === QueueStatus.WAITING || entry.status === QueueStatus.IN_PROGRESS)
  );
}

/**
 * Rebuilds the full queue's display order from a reorder draft -- walks the server's own
 * order and, at every WAITING slot, substitutes the next id from `draftOrder` instead;
 * every non-WAITING entry stays exactly where the server already put it. This mirrors
 * exactly what ReorderQueueHandler's own renumbering does server-side (see
 * planQueueReorder), so what the nurse sees mid-drag is the same shape her confirm will
 * actually produce.
 */
export function applyReorderDraft(queue: readonly QueueEntryDto[], draftOrder: readonly string[]): QueueEntryDto[] {
  const byId = new Map(queue.map((entry) => [entry.id, entry]));
  let draftIndex = 0;
  return queue.map((entry) => {
    if (!isReorderable(entry)) return entry;
    const id = draftOrder[draftIndex++];
    return (id ? byId.get(id) : undefined) ?? entry;
  });
}

/** Plain array equality for two id lists -- used to detect whether a reorder draft has
 * actually diverged from the server's own current WAITING order. */
export function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The nurse's structured "Questionário de Segurança & Contraste" (see the nursing day-view
 * feature) -- recorded and displayed as-is, same "literal union" rule as every other
 * label-key map in this file.
 */
export type AllergyStatusLabelKey = "nursing:allergyStatusNegated" | "nursing:allergyStatusPresent";

export function allergyStatusLabelKeyOf(status: AllergyStatus): AllergyStatusLabelKey {
  const byStatus: Record<AllergyStatus, AllergyStatusLabelKey> = {
    [AllergyStatus.NEGATED]: "nursing:allergyStatusNegated",
    [AllergyStatus.PRESENT]: "nursing:allergyStatusPresent",
  };
  return byStatus[status];
}

export function allergyStatusBadgeClass(status: AllergyStatus): string {
  return status === AllergyStatus.PRESENT ? "bg-[#3d1d1d] text-[#ff8b8b]" : "bg-[#1d3d2b] text-[#5fdc8a]";
}

/**
 * The queue-card status chip -- the prototype's "EM SALA" / "ALERTA JEJUM" / "ESPERA" /
 * "Concluído" wording, one level more specific than the plain `queueStatusLabelKeyOf` above:
 * a `WAITING` contrast patient who hasn't confirmed fasting gets the fasting-alert chip
 * instead of the generic "Em espera" one. This is the *only* place `fastingConfirmed`
 * derives anything -- purely a card-chip label, never a gate on any action (see
 * `nursing` namespace's own docstring on the questionnaire being record-and-display only).
 */
export type QueueCardChipLabelKey = QueueStatusLabelKey | "nursing:cardChipFastingAlert";

export function queueCardChipOf(entry: QueueEntryDto): { labelKey: QueueCardChipLabelKey; badgeClass: string } {
  if (entry.status === QueueStatus.WAITING && entry.contrastRequired && !entry.fastingConfirmed) {
    return { labelKey: "nursing:cardChipFastingAlert", badgeClass: "bg-[#3d2a1d] text-[#ffb366]" };
  }
  return { labelKey: queueStatusLabelKeyOf(entry.status), badgeClass: queueStatusBadgeClass(entry.status) };
}

/**
 * `QueueTimelineEntry.action` is a raw `AuditAction` string (see that schema's own
 * docstring on why it deliberately doesn't import the enum type itself: apps/web has no
 * dependency on which *other* audit actions exist, only the queue-related ones this
 * timeline can ever actually show). Unknown actions render as-is rather than throwing --
 * defensive only, since `GetQueueEntryTimelineHandler` never emits anything outside this
 * set today. The map's value type is the literal union below, not `string`, for the same
 * compile-time `t()`-key-checking reason as every other label-key map in this file.
 */
export type TimelineActionLabelKey =
  | "nursing:timelineActionCreated"
  | "nursing:timelineActionDetailsUpdated"
  | "nursing:timelineActionPositioned"
  | "nursing:timelineActionInjected"
  | "nursing:timelineActionReleased";

const TIMELINE_ACTION_LABEL_KEY: Record<string, TimelineActionLabelKey> = {
  QUEUE_ENTRY_CREATED: "nursing:timelineActionCreated",
  QUEUE_ENTRY_UPDATED: "nursing:timelineActionDetailsUpdated",
  PATIENT_POSITIONED: "nursing:timelineActionPositioned",
  PATIENT_INJECTED: "nursing:timelineActionInjected",
  PATIENT_RELEASED: "nursing:timelineActionReleased",
};

export function timelineActionLabelKeyOf(entry: QueueTimelineEntry): TimelineActionLabelKey | null {
  return TIMELINE_ACTION_LABEL_KEY[entry.action] ?? null;
}
