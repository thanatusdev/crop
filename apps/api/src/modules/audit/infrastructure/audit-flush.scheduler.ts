import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CommandBus } from "@nestjs/cqrs";
import { FlushAuditBufferCommand } from "../application/commands/flush-audit-buffer/flush-audit-buffer.command.js";

/**
 * Triggers FlushAuditBufferHandler on a fixed interval, configurable via
 * AUDIT_FLUSH_INTERVAL_MS (default 5s -- deliberately much tighter than the 60s in the
 * original spec, since 60s of buffered-but-unflushed input events is 60s of audit history
 * that a Redis crash could lose; see docs/architecture.md).
 *
 * Plain `setInterval`, not `@nestjs/schedule`'s `@Cron`: the interval is a runtime config
 * value, not a compile-time literal, and this is the only scheduled job that needs that.
 */
@Injectable()
export class AuditFlushScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditFlushScheduler.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly commandBus: CommandBus,
    private readonly config: ConfigService
  ) {}

  onModuleInit(): void {
    const intervalMs = this.config.get<number>("AUDIT_FLUSH_INTERVAL_MS", 5000);
    this.timer = setInterval(() => {
      this.commandBus.execute(new FlushAuditBufferCommand()).catch((err: Error) => {
        this.logger.error(`Audit flush cycle failed: ${err.message}`);
      });
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
