import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, EventBus, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction, QueueStatus, type ExamMessageDto } from "@crop/shared";
import { NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../../../../equipment/application/ports/equipment-repository.port.js";
import { QUEUE_REPOSITORY, type QueueRepositoryPort } from "../../../../queue/application/ports/queue-repository.port.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../../../iam/application/ports/user-repository.port.js";
import { OperatorAccessService } from "../../../../access/application/operator-access.service.js";
import { CHAT_ATTACHMENT_STORAGE, type ChatAttachmentStoragePort } from "../../ports/chat-attachment-storage.port.js";
import { EXAM_MESSAGE_REPOSITORY, type ExamMessageRepositoryPort } from "../../ports/exam-message-repository.port.js";
import { ExamMessage } from "../../../domain/exam-message.entity.js";
import { toExamMessageDto } from "../../../presentation/chat.dto.js";
import { ExamMessageSentEvent } from "../../events/exam-message-sent.event.js";
import { SendExamMessageCommand } from "./send-exam-message.command.js";

/**
 * Persists one exam-chat message, then publishes `ExamMessageSentEvent` so
 * `SessionsModule`'s own handler can broadcast it live -- see that event's own docstring for
 * why this is a published event rather than the gateway calling this handler directly the way
 * it used to (this is now reached from `ChatController`'s `POST /chat/messages`, a plain REST
 * write with no gateway or session-join in front of it at all; see
 * `SendExamMessageRequestSchema`'s own docstring for why sending moved off the socket).
 *
 * Re-checks tenant + agreement scope explicitly (`OperatorAccessService.assertCanReachEquipment`)
 * -- unlike the old WS-only design, where the socket's own room membership from `JOIN_SESSION`
 * already proved that once, a REST call from an arbitrary authenticated caller has no such
 * proof behind it, so this re-derives the same check `ListExamMessagesHandler` already applies
 * to reads.
 */
@CommandHandler(SendExamMessageCommand)
export class SendExamMessageHandler implements ICommandHandler<SendExamMessageCommand, ExamMessageDto> {
  constructor(
    @Inject(EXAM_MESSAGE_REPOSITORY) private readonly messages: ExamMessageRepositoryPort,
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipment: EquipmentRepositoryPort,
    @Inject(QUEUE_REPOSITORY) private readonly queue: QueueRepositoryPort,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(CHAT_ATTACHMENT_STORAGE) private readonly attachments: ChatAttachmentStoragePort,
    private readonly operatorAccess: OperatorAccessService,
    private readonly commandBus: CommandBus,
    private readonly eventBus: EventBus
  ) {}

  async execute(command: SendExamMessageCommand): Promise<ExamMessageDto> {
    const actor = command.actor;
    const equipment = await this.equipment.findById(command.equipmentId);
    if (!equipment) throw new NotFoundError("Equipment", command.equipmentId);
    if (!equipment.belongsToTenant(actor.tenantId)) throw new NotFoundError("Equipment", command.equipmentId);
    await this.operatorAccess.assertCanReachEquipment(actor, {
      id: equipment.id,
      tenantId: equipment.tenantId,
      unitId: equipment.unitId,
    });

    // The room's current patient, stamped opportunistically -- the same "IN_PROGRESS, else
    // the next WAITING" rule `currentPatientOf` expresses client-side (ExamPage's own
    // "start exam" prompt). Best-effort: a room with no queue entries at all (equipment
    // operated ad hoc) simply stamps `null`, exactly like the old gateway-read
    // `data.session.queueEntryId` already could.
    const roomQueue = await this.queue.listByEquipment(command.equipmentId);
    const queueEntryId =
      roomQueue.find((entry) => entry.status === QueueStatus.IN_PROGRESS)?.id ??
      roomQueue.find((entry) => entry.status === QueueStatus.WAITING)?.id ??
      null;

    const attachment = command.attachment
      ? {
          path: await this.attachments.save(command.equipmentId, command.attachment.filename, command.attachment.data),
          filename: command.attachment.filename,
          mimeType: command.attachment.mimeType,
          sizeBytes: command.attachment.data.length,
        }
      : null;

    const message: ExamMessage = await this.messages.create({
      equipmentId: command.equipmentId,
      queueEntryId,
      authorUserId: actor.sub,
      body: command.body,
      attachment,
    });

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: equipment.tenantId,
        userId: actor.sub,
        sessionId: null,
        action: AuditAction.EXAM_MESSAGE_SENT,
        resourceType: "ExamMessage",
        resourceId: message.id,
        // Ids and attachment metadata only, never the body or the original filename -- see
        // AuditAction.EXAM_MESSAGE_SENT's own docstring in packages/shared for why the
        // message content is never duplicated into `details`. `attachmentMimeType` is
        // recorded (it's a content-*type* fact, not content itself, same as
        // `SNAPSHOT_CAPTURED`'s own details shape), the original filename is not (a
        // clinician-chosen name can itself carry PHI, e.g. a patient's name in a photo's
        // filename).
        details: {
          equipmentId: command.equipmentId,
          queueEntryId,
          hasAttachment: attachment !== null,
          attachmentMimeType: attachment?.mimeType ?? null,
        },
      })
    );

    const authorNames = await this.users.summarizeDisplayNames([actor.sub]);
    const dto = toExamMessageDto(message, authorNames[actor.sub] ?? null);
    this.eventBus.publish(new ExamMessageSentEvent(equipment.tenantId, command.equipmentId, dto));
    return dto;
  }
}
