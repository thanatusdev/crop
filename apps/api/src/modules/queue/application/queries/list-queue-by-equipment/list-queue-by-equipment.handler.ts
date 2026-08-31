import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../../../equipment/application/ports/equipment-repository.port.js";
import { QueueEntry } from "../../../domain/queue-entry.entity.js";
import { QUEUE_REPOSITORY, type QueueRepositoryPort } from "../../ports/queue-repository.port.js";
import { ListQueueByEquipmentQuery } from "./list-queue-by-equipment.query.js";

@QueryHandler(ListQueueByEquipmentQuery)
export class ListQueueByEquipmentHandler implements IQueryHandler<ListQueueByEquipmentQuery, QueueEntry[]> {
  constructor(
    @Inject(QUEUE_REPOSITORY) private readonly queue: QueueRepositoryPort,
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort
  ) {}

  async execute(query: ListQueueByEquipmentQuery): Promise<QueueEntry[]> {
    const equipment = await this.equipment.findById(query.equipmentId);
    if (!equipment) throw new NotFoundError("Equipment", query.equipmentId);
    // Same tenant-isolation gap as the two command handlers in this module -- previously,
    // any authenticated user could list another tenant's patient queue (first names
    // included) just by passing a foreign equipmentId as a query parameter.
    if (!equipment.belongsToTenant(query.tenantId)) {
      throw new ForbiddenError("Equipment does not belong to your tenant");
    }

    return this.queue.listByEquipment(query.equipmentId);
  }
}
