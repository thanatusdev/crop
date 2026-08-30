import { Inject, Logger } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction, SessionStatus } from "@crop/shared";
import { MetricsService } from "../../../../../shared/infrastructure/metrics/metrics.service.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { PIKVM_GATEWAY, type PiKvmGatewayPort } from "../../ports/pikvm-gateway.port.js";
import { SESSION_REPOSITORY, type SessionRepositoryPort } from "../../ports/session-repository.port.js";
import { SESSION_RUNTIME, type SessionRuntimePort } from "../../ports/session-runtime.port.js";
import { AbortIdleSessionCommand } from "./abort-idle-session.command.js";

/**
 * The dead-man's switch: a session nobody has sent input for in `SESSION_IDLE_TIMEOUT_MS`
 * (default 10 minutes) is torn down automatically, releasing the equipment for the next
 * patient rather than leaving it silently reserved by a browser tab someone forgot about.
 *
 * Deliberately a distinct command from EndSessionCommand, not that command with an extra
 * "reason" flag: this transition is system-initiated and always results in `ABORTED` status,
 * never `ENDED` (which is reserved for a deliberate user action) -- and no `requestedByUserId`
 * authorization check applies here, unlike EndSessionCommand's participant check.
 */
@CommandHandler(AbortIdleSessionCommand)
export class AbortIdleSessionHandler implements ICommandHandler<AbortIdleSessionCommand, void> {
  private readonly logger = new Logger(AbortIdleSessionHandler.name);

  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
    @Inject(PIKVM_GATEWAY) private readonly pikvm: PiKvmGatewayPort,
    @Inject(SESSION_RUNTIME) private readonly runtime: SessionRuntimePort,
    private readonly commandBus: CommandBus,
    private readonly metrics: MetricsService
  ) {}

  async execute(command: AbortIdleSessionCommand): Promise<void> {
    const session = await this.sessions.findById(command.sessionId);
    if (!session || session.status !== SessionStatus.ACTIVE) return; // already handled by someone else in the meantime

    this.logger.warn(`Aborting idle session ${session.id} on equipment ${session.equipmentId}`);

    // `release()` alone is sufficient -- see EndSessionHandler's identical comment. This
    // handler had the same redundant double-reset call EndSessionHandler did, found and
    // fixed at the same time for the same reason.
    await this.pikvm.release(session.equipmentId);

    await this.sessions.end(session.id, "ABORTED");
    this.runtime.clear(session.id);
    this.metrics.sessionsActive.dec();

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: session.tenantId,
        userId: null, // system-initiated
        sessionId: session.id,
        action: AuditAction.SESSION_ABORT,
        resourceType: "Equipment",
        resourceId: session.equipmentId,
        details: { reason: "idle_timeout" },
      })
    );
  }
}
