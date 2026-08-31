import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { QUEUE_REPOSITORY, type QueueRepositoryPort } from "../../ports/queue-repository.port.js";
import { UpdateQueueStatusCommand } from "./update-queue-status.command.js";

@CommandHandler(UpdateQueueStatusCommand)
export class UpdateQueueStatusHandler implements ICommandHandler<UpdateQueueStatusCommand, void> {
  constructor(
    @Inject(QUEUE_REPOSITORY) private readonly queue: QueueRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: UpdateQueueStatusCommand): Promise<void> {
    const entry = await this.queue.findById(command.queueEntryId);
    if (!entry) throw new NotFoundError("QueueEntry", command.queueEntryId);
    // Same tenant-isolation gap as CreateQueueEntryHandler -- see its comment.
    if (!entry.belongsToTenant(command.tenantId)) {
      throw new ForbiddenError("Queue entry does not belong to your tenant");
    }

    const previousStatus = entry.status;
    entry.assertCanTransitionTo(command.status);
    await this.queue.updateStatus(command.queueEntryId, command.status);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: command.tenantId,
        userId: command.actingUserId,
        sessionId: null,
        action: AuditAction.QUEUE_ENTRY_UPDATED,
        resourceType: "QueueEntry",
        resourceId: entry.id,
        details: { equipmentId: entry.equipmentId, previousStatus, newStatus: command.status },
      })
    );
  }
}
