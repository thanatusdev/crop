import { Inject, Logger } from "@nestjs/common";
import { CommandBus, CommandHandler, EventBus, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction, QueueStatus } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { MetricsService } from "../../../../../shared/infrastructure/metrics/metrics.service.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { QUEUE_REPOSITORY, type QueueRepositoryPort } from "../../../../queue/application/ports/queue-repository.port.js";
import { QueueUpdatedEvent } from "../../../../queue/application/events/queue-updated.event.js";
import { PIKVM_GATEWAY, type PiKvmGatewayPort } from "../../ports/pikvm-gateway.port.js";
import { SESSION_REPOSITORY, type SessionRepositoryPort } from "../../ports/session-repository.port.js";
import { SESSION_RUNTIME, type SessionRuntimePort } from "../../ports/session-runtime.port.js";
import { EndSessionCommand } from "./end-session.command.js";

@CommandHandler(EndSessionCommand)
export class EndSessionHandler implements ICommandHandler<EndSessionCommand, void> {
  private readonly logger = new Logger(EndSessionHandler.name);

  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
    @Inject(PIKVM_GATEWAY) private readonly pikvm: PiKvmGatewayPort,
    @Inject(SESSION_RUNTIME) private readonly runtime: SessionRuntimePort,
    @Inject(QUEUE_REPOSITORY) private readonly queue: QueueRepositoryPort,
    private readonly commandBus: CommandBus,
    private readonly eventBus: EventBus,
    private readonly metrics: MetricsService
  ) {}

  async execute(command: EndSessionCommand): Promise<void> {
    const session = await this.sessions.findById(command.sessionId);
    if (!session) throw new NotFoundError("Session", command.sessionId);
    if (!session.isParticipant(command.requestedByUserId)) {
      throw new ForbiddenError("Only the operator or supervisor of this session may end it");
    }

    // Safety first, always: `release()` tears the connection down via `PiKvmDevice.disconnect()`,
    // which itself releases every physically-held key/button before closing anything -- see
    // that class. A separate explicit `releaseAllInput()` call here was redundant (it doubled
    // the real network round-trip against a slow/unreachable device, caught by an e2e test
    // timing out against a deliberately-unreachable fixture host) and relied on nothing else
    // changing that invariant. Equipment can only ever have one active session at a time
    // (`sessions_one_active_per_equipment`, prisma/migrations/*), so `release()` here always
    // actually disconnects rather than just decrementing a shared reference count.
    await this.pikvm.release(session.equipmentId);

    await this.sessions.end(session.id, "ENDED");
    this.runtime.clear(session.id);
    this.metrics.sessionsActive.dec();

    // See StartSessionHandler's comment on why this matters: without it, the queue entry
    // stays "WAITING" forever, and its permanently-`@unique` queueEntryId link to *this*
    // session blocks it from ever being attached to a new one. A completed exam is DONE,
    // not still waiting. Best-effort, same reasoning as the start-side transition.
    if (session.queueEntryId) {
      try {
        await this.queue.updateStatus(session.queueEntryId, QueueStatus.DONE);
        // Bug fix: this write used to never tell any connected client it happened -- the
        // nursing lock banner and DashboardPage's queue table only ever showed DONE after a
        // manual reload. See StartSessionHandler/AbortIdleSessionHandler for the same fix.
        this.eventBus.publish(new QueueUpdatedEvent(command.tenantId, session.equipmentId));
      } catch (err) {
        this.logger.warn(`Could not mark queue entry ${session.queueEntryId} DONE: ${(err as Error).message}`);
      }
    }

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: command.tenantId,
        userId: command.requestedByUserId,
        sessionId: session.id,
        action: AuditAction.SESSION_END,
        resourceType: "Equipment",
        resourceId: session.equipmentId,
        details: {},
      })
    );
  }
}
