import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";

import { QueueController } from "./presentation/queue.controller.js";
import { QUEUE_REPOSITORY } from "./application/ports/queue-repository.port.js";
import { PrismaQueueRepository } from "./infrastructure/prisma-queue.repository.js";

import { CreateQueueEntryHandler } from "./application/commands/create-queue-entry/create-queue-entry.handler.js";
import { UpdateQueueStatusHandler } from "./application/commands/update-queue-status/update-queue-status.handler.js";
import { UpdatePreparationStatusHandler } from "./application/commands/update-preparation-status/update-preparation-status.handler.js";
import { ReorderQueueHandler } from "./application/commands/reorder-queue/reorder-queue.handler.js";
import { UpdateQueueEntryDetailsHandler } from "./application/commands/update-queue-entry-details/update-queue-entry-details.handler.js";
import { UpdateTeleoperationNotesHandler } from "./application/commands/update-teleoperation-notes/update-teleoperation-notes.handler.js";
import { ListQueueByEquipmentHandler } from "./application/queries/list-queue-by-equipment/list-queue-by-equipment.handler.js";
import { GetQueueEntryHandler } from "./application/queries/get-queue-entry/get-queue-entry.handler.js";
import { GetQueueEntryTimelineHandler } from "./application/queries/get-queue-entry-timeline/get-queue-entry-timeline.handler.js";

import { EquipmentModule } from "../equipment/equipment.module.js";
import { AuditModule } from "../audit/audit.module.js";
import { IamModule } from "../iam/iam.module.js";
import { AccessModule } from "../access/access.module.js";

// Note: UpdatePreparationStatusHandler dispatches GetSessionByQueueEntryQuery (declared in
// SessionsModule) over the QueryBus, not via a module import -- SessionsModule already
// imports QueueModule (for StartSessionHandler/EndSessionHandler/AbortIdleSessionHandler), so
// importing SessionsModule here back would be a real cycle. CQRS handlers are discovered
// globally by CqrsModule regardless of which module declares them, so this works without
// QueueModule ever needing to know SessionsModule exists -- see
// GetSessionByQueueEntryQuery's own docstring for the precedent (QueueUpdatedEvent, the
// reverse direction).
const COMMAND_AND_QUERY_HANDLERS = [
  CreateQueueEntryHandler,
  UpdateQueueStatusHandler,
  UpdatePreparationStatusHandler,
  ReorderQueueHandler,
  UpdateQueueEntryDetailsHandler,
  UpdateTeleoperationNotesHandler,
  ListQueueByEquipmentHandler,
  GetQueueEntryHandler,
  GetQueueEntryTimelineHandler,
];

@Module({
  // IamModule -- QueueController/GetQueueEntryTimelineHandler both need USER_REPOSITORY
  // directly (resolving detailsUpdatedByName / a timeline row's actorName), the same
  // cross-module DI SessionsModule already uses for the identical need
  // (SessionParticipantNameService). No cycle: IamModule imports neither this module nor
  // SessionsModule.
  imports: [CqrsModule, EquipmentModule, AuditModule, IamModule, AccessModule],
  controllers: [QueueController],
  providers: [{ provide: QUEUE_REPOSITORY, useClass: PrismaQueueRepository }, ...COMMAND_AND_QUERY_HANDLERS],
  // SessionsModule needs this to keep a queue entry's status in sync with the lifecycle of
  // the session started against it (see StartSessionHandler/EndSessionHandler/
  // AbortIdleSessionHandler) -- without this export, that's exactly the kind of thing that
  // silently stays undone because nothing at the DI level forces it to exist.
  exports: [QUEUE_REPOSITORY],
})
export class QueueModule {}

