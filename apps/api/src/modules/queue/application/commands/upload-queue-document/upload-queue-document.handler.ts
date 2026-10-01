import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { QUEUE_REPOSITORY, type QueueRepositoryPort } from "../../ports/queue-repository.port.js";
import { QUEUE_DOCUMENT_REPOSITORY, type QueueDocumentRepositoryPort } from "../../ports/queue-document-repository.port.js";
import { QUEUE_DOCUMENT_STORAGE, type QueueDocumentStoragePort } from "../../ports/queue-document-storage.port.js";
import { QueueEntryDocument } from "../../../domain/queue-entry-document.entity.js";
import { UploadQueueDocumentCommand } from "./upload-queue-document.command.js";

@CommandHandler(UploadQueueDocumentCommand)
export class UploadQueueDocumentHandler implements ICommandHandler<UploadQueueDocumentCommand, QueueEntryDocument> {
  constructor(
    @Inject(QUEUE_REPOSITORY) private readonly queue: QueueRepositoryPort,
    @Inject(QUEUE_DOCUMENT_REPOSITORY) private readonly documents: QueueDocumentRepositoryPort,
    @Inject(QUEUE_DOCUMENT_STORAGE) private readonly storage: QueueDocumentStoragePort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: UploadQueueDocumentCommand): Promise<QueueEntryDocument> {
    const entry = await this.queue.findById(command.queueEntryId);
    if (!entry) throw new NotFoundError("QueueEntry", command.queueEntryId);
    if (!entry.belongsToTenant(command.tenantId)) {
      throw new ForbiddenError("Queue entry does not belong to your tenant");
    }
    // Same rule as the exam-detail form itself -- uploading a document against a DONE/
    // CANCELLED entry would be adding to a record that is supposed to be closed, not just
    // editing one. See QueueEntry.assertDetailsEditable's own docstring.
    entry.assertDetailsEditable();

    const path = await this.storage.save(entry.id, command.filename, command.data);
    const document = await this.documents.create({
      queueEntryId: entry.id,
      kind: command.kind,
      path,
      filename: command.filename,
      mimeType: command.mimeType,
      sizeBytes: command.data.length,
      uploadedByUserId: command.actingUserId,
    });

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: command.tenantId,
        userId: command.actingUserId,
        sessionId: null,
        action: AuditAction.QUEUE_DOCUMENT_ATTACHED,
        resourceType: "QueueEntry",
        resourceId: entry.id,
        // kind + mimeType only -- never filename, which can itself carry a patient's name
        // (same rule SendExamMessageHandler already follows for chat attachments).
        details: { equipmentId: entry.equipmentId, documentId: document.id, kind: document.kind, mimeType: document.mimeType },
      })
    );

    return document;
  }
}
