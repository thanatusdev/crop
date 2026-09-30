import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { QueueEntry } from "../../../domain/queue-entry.entity.js";
import { QUEUE_REPOSITORY, type QueueRepositoryPort } from "../../ports/queue-repository.port.js";
import { OperatorAccessService } from "../../../../access/application/operator-access.service.js";
import { GetQueueEntryQuery } from "./get-queue-entry.query.js";

/**
 * Backs `GET /queue/:id` -- added alongside the nursing preparation feature so `SessionPage`
 * (the Biomedical's console) can read one queue entry by the id it already has
 * (`Session.queueEntryId`) instead of re-fetching and filtering the whole per-equipment list
 * client-side. Mirrors `GetEquipmentHandler`/`GetSessionHandler`'s load-then-tenant-check
 * shape.
 */
@QueryHandler(GetQueueEntryQuery)
export class GetQueueEntryHandler implements IQueryHandler<GetQueueEntryQuery, QueueEntry> {
  constructor(@Inject(QUEUE_REPOSITORY) private readonly queue: QueueRepositoryPort,
    private readonly operatorAccess: OperatorAccessService
  ) {}

  async execute(query: GetQueueEntryQuery): Promise<QueueEntry> {
    const entry = await this.queue.findById(query.queueEntryId);
    if (!entry) throw new NotFoundError("QueueEntry", query.queueEntryId);
    if (!entry.belongsToTenant(query.tenantId)) {
      throw new ForbiddenError("Queue entry does not belong to your tenant");
    }
    if (query.actor) await this.operatorAccess.assertCanReachEquipmentId(query.actor, entry.equipmentId);
    return entry;
  }
}
