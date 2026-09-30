import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { CHAT_ALLOWED_ROLES } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../../../equipment/application/ports/equipment-repository.port.js";
import { OperatorAccessService } from "../../../../access/application/operator-access.service.js";
import { CanAccessEquipmentChatQuery } from "./can-access-equipment-chat.query.js";

/** Backs `SessionsGateway`'s `JOIN_EQUIPMENT_CHAT` handler -- see that event's own docstring
 * and `CHAT_ALLOWED_ROLES`'s own docstring for why a socket join needs this same check the
 * REST surface already has. Throws (rather than returning a boolean) so the gateway's
 * `try`/`catch` can emit one consistent `RT_EVENTS.ERROR` for every refusal reason, the same
 * shape `onJoinSession`'s own `ForbiddenError`-shaped refusals already produce. */
@QueryHandler(CanAccessEquipmentChatQuery)
export class CanAccessEquipmentChatHandler implements IQueryHandler<CanAccessEquipmentChatQuery, void> {
  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort,
    private readonly operatorAccess: OperatorAccessService
  ) {}

  async execute(query: CanAccessEquipmentChatQuery): Promise<void> {
    if (!CHAT_ALLOWED_ROLES.includes(query.actor.role)) {
      throw new ForbiddenError("This role may not use the exam-support chat");
    }
    const equipment = await this.equipment.findById(query.equipmentId);
    if (!equipment) throw new NotFoundError("Equipment", query.equipmentId);
    if (!equipment.belongsToTenant(query.actor.tenantId)) {
      throw new ForbiddenError("Equipment does not belong to your tenant");
    }
    await this.operatorAccess.assertCanReachEquipment(query.actor, {
      id: equipment.id,
      tenantId: equipment.tenantId,
      unitId: equipment.unitId,
    });
  }
}
