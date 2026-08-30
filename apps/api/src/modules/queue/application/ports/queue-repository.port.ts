import { QueueEntry } from "../../domain/queue-entry.entity.js";
import type { QueueStatus } from "@crop/shared";

export const QUEUE_REPOSITORY = Symbol("QUEUE_REPOSITORY");

export interface CreateQueueEntryData {
  equipmentId: string;
  patientFirstName: string;
  scheduledAt: Date | null;
}

export interface QueueRepositoryPort {
  /** Assigns the next position for this equipment internally, atomically. */
  create(data: CreateQueueEntryData): Promise<QueueEntry>;
  findById(id: string): Promise<QueueEntry | null>;
  listByEquipment(equipmentId: string): Promise<QueueEntry[]>;
  updateStatus(id: string, status: QueueStatus): Promise<void>;
}
