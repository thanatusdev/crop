import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { Equipment } from "../../../domain/equipment.entity.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../ports/equipment-repository.port.js";
import { ListEquipmentQuery } from "./list-equipment.query.js";

@QueryHandler(ListEquipmentQuery)
export class ListEquipmentHandler implements IQueryHandler<ListEquipmentQuery, Equipment[]> {
  constructor(@Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort) {}

  async execute(query: ListEquipmentQuery): Promise<Equipment[]> {
    return this.equipment.listByTenant(query.tenantId);
  }
}
