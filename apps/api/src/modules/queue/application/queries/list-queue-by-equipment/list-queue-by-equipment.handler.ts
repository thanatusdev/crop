import { Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { clinicDayBounds, DEFAULT_CLINIC_TIME_ZONE } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../../../equipment/application/ports/equipment-repository.port.js";
import { QueueEntry } from "../../../domain/queue-entry.entity.js";
import { QUEUE_REPOSITORY, type QueueRepositoryPort } from "../../ports/queue-repository.port.js";
import { OperatorAccessService } from "../../../../access/application/operator-access.service.js";
import { ListQueueByEquipmentQuery } from "./list-queue-by-equipment.query.js";

@QueryHandler(ListQueueByEquipmentQuery)
export class ListQueueByEquipmentHandler implements IQueryHandler<ListQueueByEquipmentQuery, QueueEntry[]> {
  constructor(
    @Inject(QUEUE_REPOSITORY) private readonly queue: QueueRepositoryPort,
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort,
    private readonly config: ConfigService,
    private readonly operatorAccess: OperatorAccessService
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

    // Tenant scoping alone no longer settles this: a contracted operator acts inside the clinic's
    // own tenant, so the check above passes for every room. Scope is what limits them to the rooms
    // the clinic granted -- and this route returns patient first names, so it matters here.
    if (query.actor) {
      await this.operatorAccess.assertCanReachEquipment(query.actor, {
        id: equipment.id,
        tenantId: equipment.tenantId,
        unitId: equipment.unitId,
      });
    }

    // No `day` at all -- the pre-existing, unscoped call shape DashboardPage and
    // StartSessionHandler's "find the next WAITING patient" flow both still use -- means no
    // date filter, exactly as before this query gained day-scoping. See the query's own
    // docstring for why this is never defaulted to "today" here.
    const dayBounds = query.day
      ? clinicDayBounds(query.day, this.config.get<string>("CLINIC_TIME_ZONE", DEFAULT_CLINIC_TIME_ZONE))
      : undefined;

    return this.queue.listByEquipment(query.equipmentId, dayBounds);
  }
}
