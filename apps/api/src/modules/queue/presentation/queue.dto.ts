import type { QueueEntryDto } from "@crop/shared";
import { QueueEntry } from "../domain/queue-entry.entity.js";

export function toQueueEntryDto(entry: QueueEntry): QueueEntryDto {
  return {
    id: entry.id,
    equipmentId: entry.equipmentId,
    patientFirstName: entry.patientFirstName,
    position: entry.position,
    status: entry.status,
    scheduledAt: entry.scheduledAt?.toISOString() ?? null,
  };
}
