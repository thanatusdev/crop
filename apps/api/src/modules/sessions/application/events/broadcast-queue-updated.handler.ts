import { EventsHandler, type IEventHandler } from "@nestjs/cqrs";
import { QueueUpdatedEvent } from "../../../queue/application/events/queue-updated.event.js";
import { SessionsGateway } from "../../presentation/sessions.gateway.js";

/**
 * Lives here, not in QueueModule, purely so it can inject SessionsGateway without
 * introducing a module import cycle -- SessionsModule already imports QueueModule (for
 * StartSessionHandler/EndSessionHandler's queue-status transitions); QueueModule importing
 * SessionsModule back, just for this, would be circular. Publishing a plain CQRS event
 * instead of calling the gateway directly sidesteps that entirely: QueueModule has no idea
 * this handler exists.
 */
@EventsHandler(QueueUpdatedEvent)
export class BroadcastQueueUpdatedHandler implements IEventHandler<QueueUpdatedEvent> {
  constructor(private readonly gateway: SessionsGateway) {}

  handle(event: QueueUpdatedEvent): void {
    this.gateway.broadcastQueueUpdated(event.tenantId, event.equipmentId);
  }
}
