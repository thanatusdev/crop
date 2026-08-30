import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { NotFoundError } from "../../../../../shared/domain/errors.js";
import { QUEUE_REPOSITORY, type QueueRepositoryPort } from "../../ports/queue-repository.port.js";
import { UpdateQueueStatusCommand } from "./update-queue-status.command.js";

@CommandHandler(UpdateQueueStatusCommand)
export class UpdateQueueStatusHandler implements ICommandHandler<UpdateQueueStatusCommand, void> {
  constructor(@Inject(QUEUE_REPOSITORY) private readonly queue: QueueRepositoryPort) {}

  async execute(command: UpdateQueueStatusCommand): Promise<void> {
    const entry = await this.queue.findById(command.queueEntryId);
    if (!entry) throw new NotFoundError("QueueEntry", command.queueEntryId);

    entry.assertCanTransitionTo(command.status);
    await this.queue.updateStatus(command.queueEntryId, command.status);
  }
}
