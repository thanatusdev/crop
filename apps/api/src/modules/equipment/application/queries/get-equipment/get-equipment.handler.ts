import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { OperatorAccessService } from "../../../../access/application/operator-access.service.js";
import { Equipment } from "../../../domain/equipment.entity.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../ports/equipment-repository.port.js";
import { GetEquipmentQuery } from "./get-equipment.query.js";

/**
 * The single most load-bearing authorization point for cross-tenant operation: `StartSessionHandler`
 * loads equipment through this query, so gating it here is what stops a contracted operator opening
 * a session on a scanner their agreement does not cover -- without touching the session module at
 * all.
 */
@QueryHandler(GetEquipmentQuery)
export class GetEquipmentHandler implements IQueryHandler<GetEquipmentQuery, Equipment> {
  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort,
    private readonly operatorAccess: OperatorAccessService
  ) {}

  async execute(query: GetEquipmentQuery): Promise<Equipment> {
    const equipment = await this.equipment.findById(query.equipmentId);
    if (!equipment) throw new NotFoundError("Equipment", query.equipmentId);
    // Multi-tenant isolation, enforced here rather than trusted to the caller: a tenant
    // can never load another tenant's equipment by guessing its UUID.
    if (!equipment.belongsToTenant(query.tenantId)) {
      throw new ForbiddenError("Equipment does not belong to your tenant");
    }

    // Tenant scoping above is necessary but no longer sufficient. A contracted operator acts
    // *inside* the clinic's tenant (see AccessTokenClaims.homeTenantId), so the check above passes
    // for every one of that clinic's scanners; the agreement's scope is what narrows it to the ones
    // the clinic actually granted. `actor` is optional so internal callers with no HTTP actor
    // (schedulers, the health poller) keep working unchanged -- they are not operating on anyone's
    // behalf and have no agreement to check.
    if (query.actor) {
      await this.operatorAccess.assertCanReachEquipment(query.actor, {
        id: equipment.id,
        tenantId: equipment.tenantId,
        unitId: equipment.unitId,
      });
    }

    return equipment;
  }
}
