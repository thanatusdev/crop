import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { OperatorAccessService } from "../../../../access/application/operator-access.service.js";
import { Equipment } from "../../../domain/equipment.entity.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../ports/equipment-repository.port.js";
import { ListEquipmentQuery } from "./list-equipment.query.js";

@QueryHandler(ListEquipmentQuery)
export class ListEquipmentHandler implements IQueryHandler<ListEquipmentQuery, Equipment[]> {
  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort,
    private readonly operatorAccess: OperatorAccessService
  ) {}

  async execute(query: ListEquipmentQuery): Promise<Equipment[]> {
    const equipment = await this.equipment.listByTenant(query.tenantId);
    if (!query.actor) return equipment;
    // Narrowed, not refused -- see ListEquipmentQuery.actor. For a clinic's own staff this is a
    // no-op that costs nothing: `filterReachableEquipment` returns immediately when the caller is
    // not acting cross-tenant, without touching the database.
    return this.operatorAccess.filterReachableEquipment(query.actor, equipment);
  }
}
