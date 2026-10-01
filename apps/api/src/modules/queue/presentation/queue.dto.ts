import type { QueueEntryDto, QueueEntryDocumentDto } from "@crop/shared";
import { QueueEntry } from "../domain/queue-entry.entity.js";

/** `detailsUpdatedByName` is resolved by the caller (`QueueController`, via
 * `USER_REPOSITORY.summarizeDisplayNames`) rather than looked up in here -- same "stay a
 * pure, synchronous mapper" reasoning `toSessionDto` already follows for `operatorName`.
 * `documents` likewise arrives pre-mapped (via `toQueueEntryDocumentDto`, batched per page
 * load) rather than being fetched in here, for the same reason. */
export function toQueueEntryDto(
  entry: QueueEntry,
  detailsUpdatedByName: string | null = null,
  documents: QueueEntryDocumentDto[] = []
): QueueEntryDto {
  return {
    id: entry.id,
    equipmentId: entry.equipmentId,
    patientFirstName: entry.patientFirstName,
    position: entry.position,
    status: entry.status,
    scheduledAt: entry.scheduledAt?.toISOString() ?? null,
    preparationStatus: entry.preparationStatus,
    positionedAt: entry.positionedAt?.toISOString() ?? null,
    injectedAt: entry.injectedAt?.toISOString() ?? null,
    releasedAt: entry.releasedAt?.toISOString() ?? null,
    examDescription: entry.examDescription,
    contrastRequired: entry.contrastRequired,
    patientSex: entry.patientSex,
    patientWeightKg: entry.patientWeightKg,
    preparationNotes: entry.preparationNotes,
    fastingConfirmed: entry.fastingConfirmed,
    fastingHours: entry.fastingHours,
    creatinineMgDl: entry.creatinineMgDl,
    allergyStatus: entry.allergyStatus,
    allergyNotes: entry.allergyNotes,
    contrastVolumeMl: entry.contrastVolumeMl,
    metforminUse: entry.metforminUse,
    anticoagulantUse: entry.anticoagulantUse,
    detailsUpdatedAt: entry.detailsUpdatedAt?.toISOString() ?? null,
    detailsUpdatedByName,
    teleoperationNotes: entry.teleoperationNotes,
    documents,
  };
}

