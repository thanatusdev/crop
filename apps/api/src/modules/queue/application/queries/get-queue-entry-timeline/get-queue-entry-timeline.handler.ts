import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import type { QueueTimelineEntry } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { AUDIT_REPOSITORY, type AuditRepositoryPort } from "../../../../audit/application/ports/audit-repository.port.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../../../iam/application/ports/user-repository.port.js";
import { QUEUE_REPOSITORY, type QueueRepositoryPort } from "../../ports/queue-repository.port.js";
import { OperatorAccessService } from "../../../../access/application/operator-access.service.js";
import { GetQueueEntryTimelineQuery } from "./get-queue-entry-timeline.query.js";

@QueryHandler(GetQueueEntryTimelineQuery)
export class GetQueueEntryTimelineHandler implements IQueryHandler<GetQueueEntryTimelineQuery, QueueTimelineEntry[]> {
  constructor(
    @Inject(QUEUE_REPOSITORY) private readonly queue: QueueRepositoryPort,
    @Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepositoryPort,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    private readonly operatorAccess: OperatorAccessService
  ) {}

  async execute(query: GetQueueEntryTimelineQuery): Promise<QueueTimelineEntry[]> {
    const entry = await this.queue.findById(query.queueEntryId);
    if (!entry) throw new NotFoundError("QueueEntry", query.queueEntryId);
    // Same tenant-isolation shape as every other queue handler.
    if (!entry.belongsToTenant(query.tenantId)) {
      throw new ForbiddenError("Queue entry does not belong to your tenant");
    }
    if (query.actor) await this.operatorAccess.assertCanReachEquipmentId(query.actor, entry.equipmentId);

    // resourceType "QueueEntry" + this exact entry's own id -- QUEUE_REORDERED rows carry
    // the *equipment's* id as resourceId (a room-level act, not this one patient's), so
    // this filter naturally never has occasion to include one. See
    // QueueTimelineEntrySchema's own docstring; not a gap, a deliberate scope.
    const rows = await this.audit.list({
      tenantId: query.tenantId,
      resourceType: "QueueEntry",
      resourceId: entry.id,
      limit: 200,
      offset: 0,
    });

    const userIds = [...new Set(rows.map((row) => row.userId).filter((id): id is string => !!id))];
    const names = await this.users.summarizeDisplayNames(userIds);

    // `AuditRepositoryPort.list` orders newest-first (seq desc) -- kept as-is: the nursing
    // timeline reads top-to-bottom as "most recent first", the same order Trilha de
    // Auditoria/AuditPage already use.
    return rows.map((row) => ({
      action: row.action,
      timestamp: row.timestamp,
      actorName: row.userId ? names[row.userId] ?? null : null,
    }));
  }
}
