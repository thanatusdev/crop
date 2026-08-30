import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { Equipment } from "../../../domain/equipment.entity.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../ports/equipment-repository.port.js";
import { GetEquipmentQuery } from "./get-equipment.query.js";

@QueryHandler(GetEquipmentQuery)
export class GetEquipmentHandler implements IQueryHandler<GetEquipmentQuery, Equipment> {
  constructor(@Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort) {}

  async execute(query: GetEquipmentQuery): Promise<Equipment> {
    const equipment = await this.equipment.findById(query.equipmentId);
    if (!equipment) throw new NotFoundError("Equipment", query.equipmentId);
    // Multi-tenant isolation, enforced here rather than trusted to the caller: a tenant
    // can never load another tenant's equipment by guessing its UUID.
    if (!equipment.belongsToTenant(query.tenantId)) {
      throw new ForbiddenError("Equipment does not belong to your tenant");
    }
    return equipment;
  }
}
