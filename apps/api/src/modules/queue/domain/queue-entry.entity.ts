import { AllergyStatus, PatientSex, PreparationStatus, QueueStatus } from "@crop/shared";
import { ConflictError } from "../../../shared/domain/errors.js";

export interface QueueEntryProps {
  id: string;
  tenantId: string;
  equipmentId: string;
  patientFirstName: string;
  position: number;
  status: QueueStatus;
  scheduledAt: Date | null;
  preparationStatus: PreparationStatus;
  positionedAt: Date | null;
  injectedAt: Date | null;
  releasedAt: Date | null;
  examDescription: string | null;
  contrastRequired: boolean;
  patientSex: PatientSex | null;
  patientWeightKg: number | null;
  preparationNotes: string | null;
  fastingConfirmed: boolean;
  fastingHours: number | null;
  creatinineMgDl: number | null;
  allergyStatus: AllergyStatus | null;
  allergyNotes: string | null;
  contrastVolumeMl: number | null;
  metforminUse: boolean | null;
  anticoagulantUse: boolean | null;
  detailsUpdatedAt: Date | null;
  detailsUpdatedByUserId: string | null;
  teleoperationNotes: string | null;
}

const VALID_TRANSITIONS: Record<QueueStatus, QueueStatus[]> = {
  [QueueStatus.WAITING]: [QueueStatus.IN_PROGRESS, QueueStatus.CANCELLED],
  [QueueStatus.IN_PROGRESS]: [QueueStatus.DONE, QueueStatus.CANCELLED],
  [QueueStatus.DONE]: [],
  [QueueStatus.CANCELLED]: [],
};

/** See PreparationStatus's own docstring in packages/shared/src/enums.ts. INJECTED is
 * deliberately skippable: POSITIONED -> RELEASED is valid, not just the strict 1-2-3 the
 * nurse's UI suggests as the default order. Nothing ever legally re-enters NOT_STARTED. */
const VALID_PREPARATION_TRANSITIONS: Record<PreparationStatus, PreparationStatus[]> = {
  [PreparationStatus.NOT_STARTED]: [PreparationStatus.POSITIONED],
  [PreparationStatus.POSITIONED]: [PreparationStatus.INJECTED, PreparationStatus.RELEASED],
  [PreparationStatus.INJECTED]: [PreparationStatus.RELEASED],
  [PreparationStatus.RELEASED]: [],
};

/** Preparation actions that touch the patient in the room only make sense while the exam
 * slot itself is still open. A CANCELLED/DONE queue entry (session already ended or the
 * patient was pulled from the queue) can't be positioned or injected -- but RELEASED is
 * allowed regardless of QueueStatus, since a patient who never got positioned in the first
 * place (queue entry cancelled before the nurse touched it) still has to be let go of the
 * screen; UpdatePreparationStatusHandler's session-active gate is the real safety check for
 * release, not this. */
const PREPARATION_STATUSES_REQUIRING_OPEN_SLOT: readonly PreparationStatus[] = [
  PreparationStatus.POSITIONED,
  PreparationStatus.INJECTED,
];

export class QueueEntry {
  constructor(private readonly props: QueueEntryProps) {}

  get id(): string {
    return this.props.id;
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get equipmentId(): string {
    return this.props.equipmentId;
  }

  get status(): QueueStatus {
    return this.props.status;
  }

  get patientFirstName(): string {
    return this.props.patientFirstName;
  }

  get position(): number {
    return this.props.position;
  }

  get scheduledAt(): Date | null {
    return this.props.scheduledAt;
  }

  get preparationStatus(): PreparationStatus {
    return this.props.preparationStatus;
  }

  get positionedAt(): Date | null {
    return this.props.positionedAt;
  }

  get injectedAt(): Date | null {
    return this.props.injectedAt;
  }

  get releasedAt(): Date | null {
    return this.props.releasedAt;
  }

  get examDescription(): string | null {
    return this.props.examDescription;
  }

  get contrastRequired(): boolean {
    return this.props.contrastRequired;
  }

  get patientSex(): PatientSex | null {
    return this.props.patientSex;
  }

  get patientWeightKg(): number | null {
    return this.props.patientWeightKg;
  }

  get preparationNotes(): string | null {
    return this.props.preparationNotes;
  }

  get fastingConfirmed(): boolean {
    return this.props.fastingConfirmed;
  }

  get fastingHours(): number | null {
    return this.props.fastingHours;
  }

  get creatinineMgDl(): number | null {
    return this.props.creatinineMgDl;
  }

  get allergyStatus(): AllergyStatus | null {
    return this.props.allergyStatus;
  }

  get allergyNotes(): string | null {
    return this.props.allergyNotes;
  }

  get contrastVolumeMl(): number | null {
    return this.props.contrastVolumeMl;
  }

  get metforminUse(): boolean | null {
    return this.props.metforminUse;
  }

  get anticoagulantUse(): boolean | null {
    return this.props.anticoagulantUse;
  }

  get detailsUpdatedAt(): Date | null {
    return this.props.detailsUpdatedAt;
  }

  get detailsUpdatedByUserId(): string | null {
    return this.props.detailsUpdatedByUserId;
  }

  get teleoperationNotes(): string | null {
    return this.props.teleoperationNotes;
  }

  /** A patient can't go from DONE/CANCELLED back to WAITING, or skip straight to DONE. */
  assertCanTransitionTo(next: QueueStatus): void {
    if (!VALID_TRANSITIONS[this.props.status].includes(next)) {
      throw new ConflictError(`Cannot move queue entry from ${this.props.status} to ${next}`);
    }
  }

  /** Mirrors assertCanTransitionTo for the orthogonal PreparationStatus axis -- see
   * UpdatePreparationStatusHandler, the only caller. */
  assertCanTransitionPreparationTo(next: PreparationStatus): void {
    if (!VALID_PREPARATION_TRANSITIONS[this.props.preparationStatus].includes(next)) {
      throw new ConflictError(`Cannot move patient preparation from ${this.props.preparationStatus} to ${next}`);
    }
    if (
      PREPARATION_STATUSES_REQUIRING_OPEN_SLOT.includes(next) &&
      this.props.status !== QueueStatus.WAITING &&
      this.props.status !== QueueStatus.IN_PROGRESS
    ) {
      throw new ConflictError(`Cannot position or inject a patient whose queue entry is ${this.props.status}`);
    }
  }

  /** Multi-tenant isolation -- see QueueController's handlers, all of which check this
   * rather than trusting a caller-supplied equipmentId/queueEntryId to already be theirs. */
  belongsToTenant(tenantId: string): boolean {
    return this.props.tenantId === tenantId;
  }

  /** The nurse's exam-detail form (examDescription/contrastRequired/patientSex/
   * patientWeightKg/scheduledAt/preparationNotes) only makes sense while the exam slot is
   * still open -- editing a DONE or CANCELLED entry's clinical prep notes after the fact
   * would rewrite history rather than record it. Deliberately more permissive than
   * PREPARATION_STATUSES_REQUIRING_OPEN_SLOT above: WAITING *and* IN_PROGRESS are both
   * editable (a nurse can still correct the weight while the exam is running), only the two
   * terminal statuses are locked out. See UpdateQueueEntryDetailsHandler, the only caller. */
  assertDetailsEditable(): void {
    if (this.props.status !== QueueStatus.WAITING && this.props.status !== QueueStatus.IN_PROGRESS) {
      throw new ConflictError(`Cannot edit exam details for a queue entry that is ${this.props.status}`);
    }
  }

  /** Mirrors `assertDetailsEditable` exactly, for the identical reason -- the operator's own
   * procedural note is a record of an exam still in progress, not something rewritten after
   * the fact. In practice this is never the binding constraint: `ExamPage`'s own "Finalizar
   * Exame & Liberar Sala" ends the session and marks the entry DONE in the same action, so a
   * note is always written before that point or not at all -- this guard exists so a second,
   * independent caller (a future admin tool, a retried request) can't reopen a finished exam's
   * record either. See UpdateTeleoperationNotesHandler, the only caller. */
  assertTeleoperationNotesEditable(): void {
    if (this.props.status !== QueueStatus.WAITING && this.props.status !== QueueStatus.IN_PROGRESS) {
      throw new ConflictError(`Cannot edit teleoperation notes for a queue entry that is ${this.props.status}`);
    }
  }
}
