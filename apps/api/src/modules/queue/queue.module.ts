import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";

import { QueueController } from "./presentation/queue.controller.js";
import { QUEUE_REPOSITORY } from "./application/ports/queue-repository.port.js";
import { PrismaQueueRepository } from "./infrastructure/prisma-queue.repository.js";

import { CreateQueueEntryHandler } from "./application/commands/create-queue-entry/create-queue-entry.handler.js";
import { UpdateQueueStatusHandler } from "./application/commands/update-queue-status/update-queue-status.handler.js";
import { ListQueueByEquipmentHandler } from "./application/queries/list-queue-by-equipment/list-queue-by-equipment.handler.js";

const COMMAND_AND_QUERY_HANDLERS = [CreateQueueEntryHandler, UpdateQueueStatusHandler, ListQueueByEquipmentHandler];

@Module({
  imports: [CqrsModule],
  controllers: [QueueController],
  providers: [{ provide: QUEUE_REPOSITORY, useClass: PrismaQueueRepository }, ...COMMAND_AND_QUERY_HANDLERS],
})
export class QueueModule {}
