import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CommandBus } from "@nestjs/cqrs";
import { SESSION_REPOSITORY, type SessionRepositoryPort } from "../application/ports/session-repository.port.js";
import { SESSION_RUNTIME, type SessionRuntimePort } from "../application/ports/session-runtime.port.js";
import { AbortIdleSessionCommand } from "../application/commands/abort-idle-session/abort-idle-session.command.js";
import { SessionsGateway } from "../presentation/sessions.gateway.js";

/**
 * The dead-man's switch sweep. Runs independently of AuditFlushScheduler and
 * SnapshotCaptureScheduler (different interval, different failure mode) but follows the same
 * "plain setInterval, single-process MVP" scope decision -- see docs/architecture.md.
 */
@Injectable()
export class SessionIdleScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionIdleScheduler.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
    @Inject(SESSION_RUNTIME) private readonly runtime: SessionRuntimePort,
    private readonly commandBus: CommandBus,
    private readonly gateway: SessionsGateway,
    private readonly config: ConfigService
  ) {}

  onModuleInit(): void {
    const sweepIntervalMs = this.config.get<number>("IDLE_SWEEP_INTERVAL_MS", 60000);
    this.timer = setInterval(() => {
      this.sweep().catch((err: Error) => this.logger.error(`Idle sweep cycle failed: ${err.message}`));
    }, sweepIntervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async sweep(): Promise<void> {
    const idleTimeoutMs = this.config.get<number>("SESSION_IDLE_TIMEOUT_MS", 600000);
    const now = Date.now();

    const activeSessions = await this.sessions.listAllActive();
    for (const session of activeSessions) {
      const lastActivity = this.runtime.getLastActivityAt(session.id) ?? session.startedAt?.getTime() ?? now;
      if (now - lastActivity <= idleTimeoutMs) continue;

      await this.commandBus.execute(new AbortIdleSessionCommand(session.id));
      this.gateway.broadcastSessionEnded(session.id);
    }
  }
}
