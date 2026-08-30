import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { QueueEntry } from "../../../domain/queue-entry.entity.js";
import { QUEUE_REPOSITORY, type QueueRepositoryPort } from "../../ports/queue-repository.port.js";
import { ListQueueByEquipmentQuery } from "./list-queue-by-equipment.query.js";

@QueryHandler(ListQueueByEquipmentQuery)
export class ListQueueByEquipmentHandler implements IQueryHandler<ListQueueByEquipmentQuery, QueueEntry[]> {
  constructor(@Inject(QUEUE_REPOSITORY) private readonly queue: QueueRepositoryPort) {}

  async execute(query: ListQueueByEquipmentQuery): Promise<QueueEntry[]> {
    return this.queue.listByEquipment(query.equipmentId);
  }
}
