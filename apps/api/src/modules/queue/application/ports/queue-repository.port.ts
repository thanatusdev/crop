import { QueueEntry } from "../../domain/queue-entry.entity.js";
import type { AllergyStatus, PatientSex, PreparationStatus, QueueStatus } from "@crop/shared";
import type { QueueReorderAssignment } from "../../domain/queue-order.js";

export const QUEUE_REPOSITORY = Symbol("QUEUE_REPOSITORY");

export interface CreateQueueEntryData {
  equipmentId: string;
  patientFirstName: string;
  scheduledAt: Date | null;
}

/** `[gte, lt)` UTC instant range -- see `clinicDayBounds` in `@crop/shared`, the only
 * producer of this shape. Matched against `scheduledAt`, falling back to `createdAt` for
 * the (nullable-`scheduledAt`) rows that predate this feature or were added with no
 * scheduled time at all -- see `PrismaQueueRepository.listByEquipment`'s own `OR` clause. */
export interface DayBounds {
  gte: Date;
  lt: Date;
}

/** Only the keys actually present get written -- see UpdateQueueEntryDetailsHandler, the
 * only caller, which builds this from whichever fields the nurse's PATCH body included.
 * `detailsUpdatedAt`/`detailsUpdatedByUserId` are the one exception: the handler always sets
 * both together, on every successful call regardless of which other keys are present, since
 * *some* exam-detail field always changed when this is called at all. */
export interface UpdateQueueEntryDetailsData {
  examDescription?: string | null;
  contrastRequired?: boolean;
  patientSex?: PatientSex | null;
  patientWeightKg?: number | null;
  scheduledAt?: Date | null;
  preparationNotes?: string | null;
  fastingConfirmed?: boolean;
  fastingHours?: number | null;
  creatinineMgDl?: number | null;
  allergyStatus?: AllergyStatus | null;
  allergyNotes?: string | null;
  contrastVolumeMl?: number | null;
  detailsUpdatedAt?: Date;
  detailsUpdatedByUserId?: string;
}

export interface QueueRepositoryPort {
  /** Assigns the next position for this equipment internally, atomically. */
  create(data: CreateQueueEntryData): Promise<QueueEntry>;
  findById(id: string): Promise<QueueEntry | null>;
  /** `dayBounds` omitted (the pre-existing call shape) returns every entry for this
   * equipment regardless of day -- see `ListQueueByEquipmentQuery`'s own docstring for why
   * that, not "today", is the unscoped default every caller but the nursing day-view still
   * relies on. */
  listByEquipment(equipmentId: string, dayBounds?: DayBounds): Promise<QueueEntry[]>;
  updateStatus(id: string, status: QueueStatus): Promise<void>;
  /** Writes `preparationStatus` and its matching timestamp column (positionedAt/injectedAt/
   * releasedAt) in a single statement, so the enum and the timestamp it denormalizes can
   * never diverge -- see PrismaQueueRepository's implementation for the status->column map. */
  updatePreparation(id: string, status: PreparationStatus, occurredAt: Date): Promise<void>;
  /** Writes every assignment in one transaction -- see planQueueReorder (the only producer
   * of this shape) for why only WAITING entries ever appear here and why every entry keeps
   * exactly the position it already had. */
  reorder(assignments: readonly QueueReorderAssignment[]): Promise<void>;
  /** Writes only the keys present on `data` -- see UpdateQueueEntryDetailsData's own
   * docstring. */
  updateDetails(id: string, data: UpdateQueueEntryDetailsData): Promise<void>;
  /** A single-field write, deliberately separate from `updateDetails` -- see
   * `QueueEntrySchema.teleoperationNotes`'s own docstring in packages/shared for why this
   * has its own command/port method rather than being one more optional key on
   * `UpdateQueueEntryDetailsData`. */
  updateTeleoperationNotes(id: string, teleoperationNotes: string): Promise<void>;
}
