import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CommandBus } from "@nestjs/cqrs";
import { SESSION_REPOSITORY, type SessionRepositoryPort } from "../application/ports/session-repository.port.js";
import { CaptureSessionSnapshotCommand } from "../application/commands/capture-session-snapshot/capture-session-snapshot.command.js";

/**
 * Captures one JPEG per active session on a fixed interval, regardless of tenant -- same
 * "plain setInterval, not a distributed cron" scope decision as AuditFlushScheduler (see
 * docs/architecture.md); a second replica would simply double the capture rate, not corrupt
 * anything, which is a much softer failure mode than the audit flush's double-flush risk.
 */
@Injectable()
export class SnapshotCaptureScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SnapshotCaptureScheduler.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
    private readonly commandBus: CommandBus,
    private readonly config: ConfigService
  ) {}

  onModuleInit(): void {
    const intervalMs = this.config.get<number>("SNAPSHOT_INTERVAL_MS", 15000);
    this.timer = setInterval(() => {
      this.captureAll().catch((err: Error) => this.logger.error(`Snapshot capture cycle failed: ${err.message}`));
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async captureAll(): Promise<void> {
    const activeSessions = await this.sessions.listAllActive();
    await Promise.all(
      activeSessions.map((session) =>
        this.commandBus
          .execute(new CaptureSessionSnapshotCommand(session.id, session.tenantId, session.equipmentId))
          .catch((err: Error) => this.logger.warn(`Snapshot capture failed for session ${session.id}: ${err.message}`))
      )
    );
  }
}
