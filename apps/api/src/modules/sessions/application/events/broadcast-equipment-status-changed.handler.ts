import { EventsHandler, type IEventHandler } from "@nestjs/cqrs";
import { EquipmentStatusChangedEvent } from "../../../equipment/application/events/equipment-status-changed.event.js";
import { SessionsGateway } from "../../presentation/sessions.gateway.js";

/** Same reasoning as BroadcastQueueUpdatedHandler -- see its own docstring. */
@EventsHandler(EquipmentStatusChangedEvent)
export class BroadcastEquipmentStatusChangedHandler implements IEventHandler<EquipmentStatusChangedEvent> {
  constructor(private readonly gateway: SessionsGateway) {}

  handle(event: EquipmentStatusChangedEvent): void {
    this.gateway.broadcastEquipmentStatusChanged(event.tenantId, event.equipmentId, event.status);
  }
}
