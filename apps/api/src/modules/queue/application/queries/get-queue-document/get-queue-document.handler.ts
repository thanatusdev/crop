import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { QueueEntryDocument } from "../../../domain/queue-entry-document.entity.js";
import { QUEUE_DOCUMENT_REPOSITORY, type QueueDocumentRepositoryPort } from "../../ports/queue-document-repository.port.js";
import { OperatorAccessService } from "../../../../access/application/operator-access.service.js";
import { GetQueueDocumentQuery } from "./get-queue-document.query.js";

/**
 * Backs the document-content/download route. Deliberately the one place in this feature
 * that is *not* gated by `assertDetailsEditable()` -- a completed exam's physician's order
 * is still a record worth retrieving, and the remote operator (who never writes this list at
 * all) has no reason to lose read access to it the moment the nurse marks the exam DONE.
 *
 * Checks `OperatorAccessService.assertCanReachEquipmentId`, which `UploadQueueDocumentHandler`
 * /`RemoveQueueDocumentHandler` deliberately do not: those two are nurse-side writes, always
 * same-tenant, same-clinic, so cross-tenant agreement scope never applies to them. This route
 * is the one a contracted operator reaches too, so it is the one that needs the check -- the
 * identical split `GetQueueEntryHandler` already draws from the queue-entry write handlers.
 */
@QueryHandler(GetQueueDocumentQuery)
export class GetQueueDocumentHandler implements IQueryHandler<GetQueueDocumentQuery, QueueEntryDocument> {
  constructor(
    @Inject(QUEUE_DOCUMENT_REPOSITORY) private readonly documents: QueueDocumentRepositoryPort,
    private readonly operatorAccess: OperatorAccessService
  ) {}

  async execute(query: GetQueueDocumentQuery): Promise<QueueEntryDocument> {
    const document = await this.documents.findById(query.documentId);
    if (!document || document.queueEntryId !== query.queueEntryId) {
      throw new NotFoundError("QueueEntryDocument", query.documentId);
    }
    if (!document.belongsToTenant(query.tenantId)) {
      throw new ForbiddenError("Document does not belong to your tenant");
    }
    if (query.actor) await this.operatorAccess.assertCanReachEquipmentId(query.actor, document.equipmentId);
    return document;
  }
}
