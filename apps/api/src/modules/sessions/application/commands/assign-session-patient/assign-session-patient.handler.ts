import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, EventBus, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction, QueueStatus } from "@crop/shared";
import { ConflictError, ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { QUEUE_REPOSITORY, type QueueRepositoryPort } from "../../../../queue/application/ports/queue-repository.port.js";
import { QueueUpdatedEvent } from "../../../../queue/application/events/queue-updated.event.js";
import { Session } from "../../../domain/session.entity.js";
import { SESSION_REPOSITORY, type SessionRepositoryPort } from "../../ports/session-repository.port.js";
import { AssignSessionPatientCommand } from "./assign-session-patient.command.js";

/**
 * Starts a waiting patient's exam inside a session that was opened without one -- the
 * operator's "start now, pick the patient once they're on the table" flow on the exam page.
 * Mirrors StartSessionHandler's queue side effects (entry -> IN_PROGRESS, written by the
 * repository in the same transaction as the link, + QueueUpdatedEvent); EndSessionHandler
 * then marks it DONE exactly as if the session had started with it.
 */
@CommandHandler(AssignSessionPatientCommand)
export class AssignSessionPatientHandler implements ICommandHandler<AssignSessionPatientCommand, Session> {
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
    @Inject(QUEUE_REPOSITORY) private readonly queue: QueueRepositoryPort,
    private readonly commandBus: CommandBus,
    private readonly eventBus: EventBus
  ) {}

  async execute(command: AssignSessionPatientCommand): Promise<Session> {
    const session = await this.sessions.findById(command.sessionId);
    if (!session) throw new NotFoundError("Session", command.sessionId);
    if (!session.isParticipant(command.requestedByUserId)) {
      throw new ForbiddenError("Somente o operador ou o supervisor desta sessão pode iniciar o exame de um paciente.");
    }
    if (!session.isActive()) {
      throw new ConflictError("Esta sessão não está mais ativa.");
    }
    if (session.queueEntryId) {
      throw new ConflictError("Esta sessão já possui um paciente.");
    }

    const entry = await this.queue.findById(command.queueEntryId);
    if (!entry || entry.tenantId !== session.tenantId || entry.equipmentId !== session.equipmentId) {
      throw new NotFoundError("QueueEntry", command.queueEntryId);
    }
    if (entry.status !== QueueStatus.WAITING) {
      throw new ConflictError("Este paciente não está mais aguardando na fila.");
    }

    const assigned = await this.sessions.assignQueueEntry(session.id, entry.id);
    if (!assigned) {
      throw new ConflictError("Esta sessão já possui um paciente.");
    }

    this.eventBus.publish(new QueueUpdatedEvent(session.tenantId, session.equipmentId));

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        // The session's tenant, not the caller's: a cross-tenant supervisor or a
        // PLATFORM_ADMIN acting here must not write this into their own tenant's chain.
        tenantId: session.tenantId,
        userId: command.requestedByUserId,
        sessionId: session.id,
        action: AuditAction.SESSION_PATIENT_ASSIGNED,
        resourceType: "QueueEntry",
        resourceId: entry.id,
        details: { queueEntryId: entry.id },
      })
    );

    const updated = await this.sessions.findById(session.id);
    if (!updated) throw new NotFoundError("Session", session.id);
    return updated;
  }
}
