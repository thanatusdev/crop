import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, EventBus, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { QUEUE_REPOSITORY, type QueueRepositoryPort } from "../../ports/queue-repository.port.js";
import { OperatorAccessService } from "../../../../access/application/operator-access.service.js";
import { QueueUpdatedEvent } from "../../events/queue-updated.event.js";
import { UpdateTeleoperationNotesCommand } from "./update-teleoperation-notes.command.js";

/**
 * The remote operator's own note on the exam -- see `QueueEntrySchema.teleoperationNotes`'s
 * own docstring for why this is a separate command from `UpdateQueueEntryDetailsHandler`
 * rather than one more field on it: that handler's authorization boundary is "the nurse
 * edits her own fields" (enforced by `QueueController`'s narrower `@Roles` on that route);
 * this one is reached by `PATCH /queue/:id/teleoperation-notes`, gated to operator-side
 * roles instead, and the two must never be able to write each other's field.
 */
@CommandHandler(UpdateTeleoperationNotesCommand)
export class UpdateTeleoperationNotesHandler implements ICommandHandler<UpdateTeleoperationNotesCommand, void> {
  constructor(
    @Inject(QUEUE_REPOSITORY) private readonly queue: QueueRepositoryPort,
    private readonly commandBus: CommandBus,
    private readonly eventBus: EventBus,
    private readonly operatorAccess: OperatorAccessService
  ) {}

  async execute(command: UpdateTeleoperationNotesCommand): Promise<void> {
    const entry = await this.queue.findById(command.queueEntryId);
    if (!entry) throw new NotFoundError("QueueEntry", command.queueEntryId);
    if (!entry.belongsToTenant(command.tenantId)) {
      throw new ForbiddenError("Queue entry does not belong to your tenant");
    }
    // Same agreement-scope check every other operator-side queue write already applies (see
    // UpdateQueueStatusHandler) -- a contracted operator writing a note on a room their
    // agreement doesn't cover is exactly the leak that check exists to close.
    if (command.actor) await this.operatorAccess.assertCanReachEquipmentId(command.actor, entry.equipmentId);
    entry.assertTeleoperationNotesEditable();

    await this.queue.updateTeleoperationNotes(command.queueEntryId, command.teleoperationNotes);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: command.tenantId,
        userId: command.actingUserId,
        sessionId: null,
        action: AuditAction.QUEUE_ENTRY_UPDATED,
        resourceType: "QueueEntry",
        resourceId: entry.id,
        // Deliberately no note content -- same PHI-minimization rule every other queue audit
        // row in this codebase already follows (see QUEUE_REORDERED's own docstring): the
        // field name identifies *what* changed, never the free-text clinical content itself.
        details: { equipmentId: entry.equipmentId, changedFields: ["teleoperationNotes"] },
      })
    );

    this.eventBus.publish(new QueueUpdatedEvent(command.tenantId, entry.equipmentId));
  }
}
