import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, EventBus, QueryBus, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction, PreparationStatus, type UpdatePreparationStatusRequest } from "@crop/shared";
import { ConflictError, ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import type { Session } from "../../../../sessions/domain/session.entity.js";
import { GetSessionByQueueEntryQuery } from "../../../../sessions/application/queries/get-session-by-queue-entry/get-session-by-queue-entry.query.js";
import { QUEUE_REPOSITORY, type QueueRepositoryPort } from "../../ports/queue-repository.port.js";
import { PatientPreparationUpdatedEvent } from "../../events/patient-preparation-updated.event.js";
import { UpdatePreparationStatusCommand } from "./update-preparation-status.command.js";

/** One action per transition (see AuditAction's own docstring in packages/shared for why),
 * so this handler never has to reconstruct "what happened" from a generic
 * previousPreparationStatus field in a details blob. Keyed by the same narrowed union as
 * `UpdatePreparationStatusCommand.status` (never NOT_STARTED), so TypeScript's exhaustiveness
 * on this Record catches a future regression before it would silently mis-audit. */
const PREPARATION_AUDIT_ACTION: Record<UpdatePreparationStatusRequest["status"], AuditAction> = {
  [PreparationStatus.POSITIONED]: AuditAction.PATIENT_POSITIONED,
  [PreparationStatus.INJECTED]: AuditAction.PATIENT_INJECTED,
  [PreparationStatus.RELEASED]: AuditAction.PATIENT_RELEASED,
};

@CommandHandler(UpdatePreparationStatusCommand)
export class UpdatePreparationStatusHandler implements ICommandHandler<UpdatePreparationStatusCommand, void> {
  constructor(
    @Inject(QUEUE_REPOSITORY) private readonly queue: QueueRepositoryPort,
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly eventBus: EventBus
  ) {}

  async execute(command: UpdatePreparationStatusCommand): Promise<void> {
    const entry = await this.queue.findById(command.queueEntryId);
    if (!entry) throw new NotFoundError("QueueEntry", command.queueEntryId);
    // Same tenant-isolation shape as UpdateQueueStatusHandler.
    if (!entry.belongsToTenant(command.tenantId)) {
      throw new ForbiddenError("Queue entry does not belong to your tenant");
    }

    const previousPreparationStatus = entry.preparationStatus;
    entry.assertCanTransitionPreparationTo(command.status);

    // Fetched once, used both for the release gate below and for correlating the audit row
    // / broadcast event to a session id. Dispatched over the QueryBus rather than a direct
    // import of SessionsModule's repository -- SessionsModule already imports QueueModule
    // (for StartSessionHandler/EndSessionHandler), so a reverse import here would be a real
    // module cycle; see GetSessionByQueueEntryQuery's own docstring for the precedent
    // (QueueUpdatedEvent).
    const session: Session | null = await this.queryBus.execute(new GetSessionByQueueEntryQuery(command.queueEntryId));

    // The business rule this whole feature exists to enforce: the nurse cannot release the
    // patient from the room until the Biomedical's exam is no longer in progress. No session
    // at all is not blocked: a patient whose queue entry never got a session (cancelled
    // before the operator started one) still has to be let go of the screen.
    if (command.status === PreparationStatus.RELEASED && session?.isActive()) {
      throw new ConflictError(
        "Cannot release the patient while the exam is still in progress. Wait for the Biomedical to end the session."
      );
    }

    const occurredAt = new Date();
    await this.queue.updatePreparation(command.queueEntryId, command.status, occurredAt);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: command.tenantId,
        userId: command.actingUserId,
        sessionId: session?.id ?? null,
        action: PREPARATION_AUDIT_ACTION[command.status],
        resourceType: "QueueEntry",
        resourceId: entry.id,
        // Deliberately no patientFirstName -- same reasoning as CreateQueueEntryHandler and
        // UpdateQueueStatusHandler; see queue-tenant-isolation.e2e.spec.ts's PHI assertion.
        details: { equipmentId: entry.equipmentId, previousPreparationStatus },
      })
    );

    this.eventBus.publish(
      new PatientPreparationUpdatedEvent(command.tenantId, entry.equipmentId, entry.id, session?.id ?? null)
    );
  }
}
