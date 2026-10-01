import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { QUEUE_REPOSITORY, type QueueRepositoryPort } from "../../ports/queue-repository.port.js";
import { QUEUE_DOCUMENT_REPOSITORY, type QueueDocumentRepositoryPort } from "../../ports/queue-document-repository.port.js";
import { QUEUE_DOCUMENT_STORAGE, type QueueDocumentStoragePort } from "../../ports/queue-document-storage.port.js";
import { RemoveQueueDocumentCommand } from "./remove-queue-document.command.js";

@CommandHandler(RemoveQueueDocumentCommand)
export class RemoveQueueDocumentHandler implements ICommandHandler<RemoveQueueDocumentCommand, void> {
  constructor(
    @Inject(QUEUE_REPOSITORY) private readonly queue: QueueRepositoryPort,
    @Inject(QUEUE_DOCUMENT_REPOSITORY) private readonly documents: QueueDocumentRepositoryPort,
    @Inject(QUEUE_DOCUMENT_STORAGE) private readonly storage: QueueDocumentStoragePort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: RemoveQueueDocumentCommand): Promise<void> {
    const entry = await this.queue.findById(command.queueEntryId);
    if (!entry) throw new NotFoundError("QueueEntry", command.queueEntryId);
    if (!entry.belongsToTenant(command.tenantId)) {
      throw new ForbiddenError("Queue entry does not belong to your tenant");
    }
    entry.assertDetailsEditable();

    const document = await this.documents.findById(command.documentId);
    // A real document id for a *different* queue entry is treated identically to a
    // nonexistent one -- see RemoveQueueDocumentCommand's own docstring.
    if (!document || document.queueEntryId !== command.queueEntryId) {
      throw new NotFoundError("QueueEntryDocument", command.documentId);
    }

    // Row before bytes -- see QueueDocumentRepositoryPort.delete's own docstring on why
    // that ordering, not the reverse, is the one that can't leave a document reachable
    // after this call returns successfully.
    await this.documents.delete(document.id);
    await this.storage.delete(document.path);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: command.tenantId,
        userId: command.actingUserId,
        sessionId: null,
        action: AuditAction.QUEUE_DOCUMENT_REMOVED,
        resourceType: "QueueEntry",
        resourceId: entry.id,
        details: { equipmentId: entry.equipmentId, documentId: document.id, kind: document.kind, mimeType: document.mimeType },
      })
    );
  }
}
