import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";

import { AuditController } from "./presentation/audit.controller.js";
import { AUDIT_REPOSITORY } from "./application/ports/audit-repository.port.js";
import { AUDIT_BUFFER } from "./application/ports/audit-buffer.port.js";
import { PrismaAuditRepository } from "./infrastructure/prisma-audit.repository.js";
import { RedisAuditBufferAdapter } from "./infrastructure/redis-audit-buffer.adapter.js";
import { AuditFlushScheduler } from "./infrastructure/audit-flush.scheduler.js";

import { RecordAuditEventHandler } from "./application/commands/record-audit-event/record-audit-event.handler.js";
import { BufferInputEventHandler } from "./application/commands/buffer-input-batch/buffer-input-event.handler.js";
import { FlushAuditBufferHandler } from "./application/commands/flush-audit-buffer/flush-audit-buffer.handler.js";
import { ListAuditLogsHandler } from "./application/queries/list-audit-logs/list-audit-logs.handler.js";
import { VerifyAuditChainHandler } from "./application/queries/verify-audit-chain/verify-audit-chain.handler.js";

const COMMAND_AND_QUERY_HANDLERS = [
  RecordAuditEventHandler,
  BufferInputEventHandler,
  FlushAuditBufferHandler,
  ListAuditLogsHandler,
  VerifyAuditChainHandler,
];

@Module({
  imports: [CqrsModule],
  controllers: [AuditController],
  providers: [
    { provide: AUDIT_REPOSITORY, useClass: PrismaAuditRepository },
    { provide: AUDIT_BUFFER, useClass: RedisAuditBufferAdapter },
    AuditFlushScheduler,
    ...COMMAND_AND_QUERY_HANDLERS,
  ],
  exports: [CqrsModule],
})
export class AuditModule {}
