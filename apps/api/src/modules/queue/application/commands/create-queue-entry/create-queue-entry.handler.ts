import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { QueueEntry } from "../../../domain/queue-entry.entity.js";
import { QUEUE_REPOSITORY, type QueueRepositoryPort } from "../../ports/queue-repository.port.js";
import { CreateQueueEntryCommand } from "./create-queue-entry.command.js";

@CommandHandler(CreateQueueEntryCommand)
export class CreateQueueEntryHandler implements ICommandHandler<CreateQueueEntryCommand, QueueEntry> {
  constructor(@Inject(QUEUE_REPOSITORY) private readonly queue: QueueRepositoryPort) {}

  async execute(command: CreateQueueEntryCommand): Promise<QueueEntry> {
    return this.queue.create({
      equipmentId: command.equipmentId,
      patientFirstName: command.patientFirstName,
      scheduledAt: command.scheduledAt,
    });
  }
}
