import { Inject } from "@nestjs/common";
import { EventsHandler, type IEventHandler } from "@nestjs/cqrs";
import type { PatientPreparationUpdatedEvent as PatientPreparationUpdatedPayload } from "@crop/shared";
import { PatientPreparationUpdatedEvent } from "../../../queue/application/events/patient-preparation-updated.event.js";
import { QUEUE_REPOSITORY, type QueueRepositoryPort } from "../../../queue/application/ports/queue-repository.port.js";
import { SessionsGateway } from "../../presentation/sessions.gateway.js";

/**
 * Lives here, not in QueueModule, for the same anti-cycle reason as
 * BroadcastQueueUpdatedHandler (see its own docstring) -- QueueModule has no idea this
 * handler exists. Re-reads the queue entry (rather than carrying its preparation fields on
 * the domain event itself) so the broadcast payload is always exactly what a fresh
 * `GET /queue/:id` would return, with one source of truth for the shape.
 */
@EventsHandler(PatientPreparationUpdatedEvent)
export class BroadcastPatientPreparationUpdatedHandler implements IEventHandler<PatientPreparationUpdatedEvent> {
  constructor(
    private readonly gateway: SessionsGateway,
    @Inject(QUEUE_REPOSITORY) private readonly queue: QueueRepositoryPort
  ) {}

  async handle(event: PatientPreparationUpdatedEvent): Promise<void> {
    const entry = await this.queue.findById(event.queueEntryId);
    // Defensive only -- `findById` is nullable by signature, but this codebase never
    // hard-deletes a QueueEntry (see docs/architecture.md), so this branch should be
    // unreachable in practice.
    if (!entry) return;

    const payload: PatientPreparationUpdatedPayload = {
      queueEntryId: entry.id,
      equipmentId: entry.equipmentId,
      preparationStatus: entry.preparationStatus,
      positionedAt: entry.positionedAt?.toISOString() ?? null,
      injectedAt: entry.injectedAt?.toISOString() ?? null,
      releasedAt: entry.releasedAt?.toISOString() ?? null,
    };
    this.gateway.broadcastPatientPreparationUpdated(event.tenantId, event.sessionId, payload);
  }
}
