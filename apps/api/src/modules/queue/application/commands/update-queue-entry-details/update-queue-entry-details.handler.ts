import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, EventBus, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { QUEUE_REPOSITORY, type QueueRepositoryPort, type UpdateQueueEntryDetailsData } from "../../ports/queue-repository.port.js";
import { QueueUpdatedEvent } from "../../events/queue-updated.event.js";
import { UpdateQueueEntryDetailsCommand } from "./update-queue-entry-details.command.js";

@CommandHandler(UpdateQueueEntryDetailsCommand)
export class UpdateQueueEntryDetailsHandler implements ICommandHandler<UpdateQueueEntryDetailsCommand, void> {
  constructor(
    @Inject(QUEUE_REPOSITORY) private readonly queue: QueueRepositoryPort,
    private readonly commandBus: CommandBus,
    private readonly eventBus: EventBus
  ) {}

  async execute(command: UpdateQueueEntryDetailsCommand): Promise<void> {
    const entry = await this.queue.findById(command.queueEntryId);
    if (!entry) throw new NotFoundError("QueueEntry", command.queueEntryId);
    // Same tenant-isolation shape as every other queue handler.
    if (!entry.belongsToTenant(command.tenantId)) {
      throw new ForbiddenError("Queue entry does not belong to your tenant");
    }
    // Editing a DONE/CANCELLED entry's clinical prep details would rewrite history rather
    // than record it -- see QueueEntry.assertDetailsEditable's own docstring.
    entry.assertDetailsEditable();

    // Only the keys the caller actually sent (UpdateQueueEntryDetailsRequestSchema already
    // guarantees at least one) go into the patch and the audit trail -- undefined means
    // "leave this field alone", not "clear it to undefined".
    const patch: UpdateQueueEntryDetailsData = {};
    const changedFields: string[] = [];
    if (command.examDescription !== undefined) {
      patch.examDescription = command.examDescription;
      changedFields.push("examDescription");
    }
    if (command.contrastRequired !== undefined) {
      patch.contrastRequired = command.contrastRequired;
      changedFields.push("contrastRequired");
    }
    if (command.patientSex !== undefined) {
      patch.patientSex = command.patientSex;
      changedFields.push("patientSex");
    }
    if (command.patientWeightKg !== undefined) {
      patch.patientWeightKg = command.patientWeightKg;
      changedFields.push("patientWeightKg");
    }
    if (command.scheduledAt !== undefined) {
      patch.scheduledAt = command.scheduledAt;
      changedFields.push("scheduledAt");
    }
    if (command.preparationNotes !== undefined) {
      patch.preparationNotes = command.preparationNotes;
      changedFields.push("preparationNotes");
    }
    if (command.fastingConfirmed !== undefined) {
      patch.fastingConfirmed = command.fastingConfirmed;
      changedFields.push("fastingConfirmed");
    }
    if (command.fastingHours !== undefined) {
      patch.fastingHours = command.fastingHours;
      changedFields.push("fastingHours");
    }
    if (command.creatinineMgDl !== undefined) {
      patch.creatinineMgDl = command.creatinineMgDl;
      changedFields.push("creatinineMgDl");
    }
    if (command.allergyStatus !== undefined) {
      patch.allergyStatus = command.allergyStatus;
      changedFields.push("allergyStatus");
    }
    if (command.allergyNotes !== undefined) {
      patch.allergyNotes = command.allergyNotes;
      changedFields.push("allergyNotes");
    }
    if (command.contrastVolumeMl !== undefined) {
      patch.contrastVolumeMl = command.contrastVolumeMl;
      changedFields.push("contrastVolumeMl");
    }

    // Attribution -- written on every successful call regardless of which fields above
    // changed (UpdateQueueEntryDetailsRequestSchema's own superRefine already guarantees
    // at least one did), for the "Registrado às HH:mm por <nome>" line. Never part of
    // `changedFields` itself: it's metadata about the write, not a field the nurse edited.
    patch.detailsUpdatedAt = new Date();
    patch.detailsUpdatedByUserId = command.actingUserId;

    await this.queue.updateDetails(entry.id, patch);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: command.tenantId,
        userId: command.actingUserId,
        sessionId: null,
        action: AuditAction.QUEUE_ENTRY_UPDATED,
        resourceType: "QueueEntry",
        resourceId: entry.id,
        // Field *names* only -- preparationNotes/patientWeightKg/patientSex/examDescription
        // are clinical data, and the audit table must not become a second, less-protected
        // copy of it. Mirrors CreateQueueEntryHandler/UpdatePreparationStatusHandler's own
        // "prove the action happened, don't duplicate the patient data" rule.
        details: { equipmentId: entry.equipmentId, changedFields },
      })
    );

    this.eventBus.publish(new QueueUpdatedEvent(command.tenantId, entry.equipmentId));
  }
}
