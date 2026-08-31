import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { JwtModule } from "@nestjs/jwt";

import { SessionsController } from "./presentation/sessions.controller.js";
import { SessionsGateway } from "./presentation/sessions.gateway.js";
import { MediaStreamServer } from "./infrastructure/media-stream-server.js";
import { MediaStreamTicketService } from "./infrastructure/media-stream-ticket.service.js";
import { SnapshotCaptureScheduler } from "./infrastructure/snapshot-capture.scheduler.js";
import { SessionIdleScheduler } from "./infrastructure/session-idle.scheduler.js";

import { SESSION_REPOSITORY } from "./application/ports/session-repository.port.js";
import { SESSION_RUNTIME } from "./application/ports/session-runtime.port.js";
import { PIKVM_GATEWAY } from "./application/ports/pikvm-gateway.port.js";
import { SESSION_SNAPSHOT_REPOSITORY } from "./application/ports/session-snapshot-repository.port.js";
import { SNAPSHOT_STORAGE } from "./application/ports/snapshot-storage.port.js";

import { PrismaSessionRepository } from "./infrastructure/prisma-session.repository.js";
import { InMemorySessionRuntimeRegistry } from "./infrastructure/session-runtime.registry.js";
import { PiKvmConnectionRegistry } from "./infrastructure/pikvm-connection-registry.js";
import { PrismaSessionSnapshotRepository } from "./infrastructure/prisma-session-snapshot.repository.js";
import { SnapshotStorageService } from "./infrastructure/snapshot-storage.service.js";

import { StartSessionHandler } from "./application/commands/start-session/start-session.handler.js";
import { EndSessionHandler } from "./application/commands/end-session/end-session.handler.js";
import { ExecuteTakeoverHandler } from "./application/commands/execute-takeover/execute-takeover.handler.js";
import { ReturnControlToOperatorHandler } from "./application/commands/return-control-to-operator/return-control-to-operator.handler.js";
import { ProcessHidInputHandler } from "./application/commands/process-hid-input/process-hid-input.handler.js";
import { PrintTextHandler } from "./application/commands/print-text/print-text.handler.js";
import { CaptureSessionSnapshotHandler } from "./application/commands/capture-session-snapshot/capture-session-snapshot.handler.js";
import { AbortIdleSessionHandler } from "./application/commands/abort-idle-session/abort-idle-session.handler.js";
import { ReleaseAllInputHandler } from "./application/commands/release-all-input/release-all-input.handler.js";
import { GetActiveSessionsHandler } from "./application/queries/get-active-sessions/get-active-sessions.handler.js";
import { GetSessionHandler } from "./application/queries/get-session/get-session.handler.js";
import { ListSessionSnapshotsHandler } from "./application/queries/list-session-snapshots/list-session-snapshots.handler.js";
import { BroadcastQueueUpdatedHandler } from "./application/events/broadcast-queue-updated.handler.js";
import { BroadcastEquipmentStatusChangedHandler } from "./application/events/broadcast-equipment-status-changed.handler.js";

import { IamModule } from "../iam/iam.module.js";
import { EquipmentModule } from "../equipment/equipment.module.js";
import { AuditModule } from "../audit/audit.module.js";
import { QueueModule } from "../queue/queue.module.js";

const COMMAND_AND_QUERY_HANDLERS = [
  StartSessionHandler,
  EndSessionHandler,
  ExecuteTakeoverHandler,
  ReturnControlToOperatorHandler,
  ProcessHidInputHandler,
  PrintTextHandler,
  CaptureSessionSnapshotHandler,
  AbortIdleSessionHandler,
  ReleaseAllInputHandler,
  GetActiveSessionsHandler,
  GetSessionHandler,
  ListSessionSnapshotsHandler,
  BroadcastQueueUpdatedHandler,
  BroadcastEquipmentStatusChangedHandler,
];

@Module({
  imports: [CqrsModule, JwtModule.register({}), IamModule, EquipmentModule, AuditModule, QueueModule],
  controllers: [SessionsController],
  providers: [
    { provide: SESSION_REPOSITORY, useClass: PrismaSessionRepository },
    { provide: SESSION_RUNTIME, useClass: InMemorySessionRuntimeRegistry },
    { provide: PIKVM_GATEWAY, useClass: PiKvmConnectionRegistry },
    { provide: SESSION_SNAPSHOT_REPOSITORY, useClass: PrismaSessionSnapshotRepository },
    { provide: SNAPSHOT_STORAGE, useClass: SnapshotStorageService },
    MediaStreamTicketService,
    MediaStreamServer,
    SessionsGateway,
    SnapshotCaptureScheduler,
    SessionIdleScheduler,
    ...COMMAND_AND_QUERY_HANDLERS,
  ],
})
export class SessionsModule {}
