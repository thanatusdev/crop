import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";

import { ChatController } from "./presentation/chat.controller.js";
import { EXAM_MESSAGE_REPOSITORY } from "./application/ports/exam-message-repository.port.js";
import { PrismaExamMessageRepository } from "./infrastructure/prisma-exam-message.repository.js";
import { MESSAGE_SHORTCUT_REPOSITORY } from "./application/ports/message-shortcut-repository.port.js";
import { PrismaMessageShortcutRepository } from "./infrastructure/prisma-message-shortcut.repository.js";
import { CHAT_ATTACHMENT_STORAGE } from "./application/ports/chat-attachment-storage.port.js";
import { ChatAttachmentStorageService } from "./infrastructure/chat-attachment-storage.service.js";

import { SendExamMessageHandler } from "./application/commands/send-exam-message/send-exam-message.handler.js";
import { CreateMessageShortcutHandler } from "./application/commands/create-message-shortcut/create-message-shortcut.handler.js";
import { SeedDefaultShortcutsHandler } from "./application/events/seed-default-shortcuts.handler.js";
import { ListExamMessagesHandler } from "./application/queries/list-exam-messages/list-exam-messages.handler.js";
import { GetExamMessageHandler } from "./application/queries/get-exam-message/get-exam-message.handler.js";
import { CanAccessEquipmentChatHandler } from "./application/queries/can-access-equipment-chat/can-access-equipment-chat.handler.js";
import { ListMessageShortcutsHandler } from "./application/queries/list-message-shortcuts/list-message-shortcuts.handler.js";

import { EquipmentModule } from "../equipment/equipment.module.js";
import { QueueModule } from "../queue/queue.module.js";
import { AuditModule } from "../audit/audit.module.js";
import { IamModule } from "../iam/iam.module.js";
import { AccessModule } from "../access/access.module.js";

const COMMAND_AND_QUERY_HANDLERS = [
  SendExamMessageHandler,
  CreateMessageShortcutHandler,
  SeedDefaultShortcutsHandler,
  ListExamMessagesHandler,
  GetExamMessageHandler,
  CanAccessEquipmentChatHandler,
  ListMessageShortcutsHandler,
];

/**
 * The exam-support chat and its quick-reply shortcuts. `SendExamMessageHandler` is dispatched
 * from `ChatController`'s own `POST /chat/messages` now (sending moved off the socket -- see
 * `SendExamMessageRequestSchema`'s own docstring), and in turn publishes
 * `ExamMessageSentEvent`, picked up by `SessionsModule`'s own handler -- the identical
 * anti-cycle shape `QueueUpdatedEvent` already uses, just travelling the opposite direction
 * (there, `QueueModule` publishes and `SessionsModule` reacts; here, `ChatModule` publishes
 * and `SessionsModule` reacts too, but the write itself now originates from this module's own
 * controller rather than from the gateway). `CanAccessEquipmentChatHandler` is the same shape
 * again, in reverse: `SessionsGateway`'s `JOIN_EQUIPMENT_CHAT` handler dispatches a *query*
 * into this module, so `SessionsModule` never needs to import `AccessModule` directly.
 *
 * EquipmentModule: EQUIPMENT_REPOSITORY, for the tenant/scope checks every handler applies.
 * QueueModule: QUEUE_REPOSITORY, for `SendExamMessageHandler`'s own current-patient lookup
 * (see that handler's own docstring for why it now resolves this itself). AuditModule: the
 * EXAM_MESSAGE_SENT/MESSAGE_SHORTCUT_CREATED rows. IamModule: USER_REPOSITORY, for resolving
 * author display names at the presentation boundary. AccessModule: OperatorAccessService,
 * for the agreement-scope check every handler applies.
 */
@Module({
  imports: [CqrsModule, EquipmentModule, QueueModule, AuditModule, IamModule, AccessModule],
  controllers: [ChatController],
  providers: [
    { provide: EXAM_MESSAGE_REPOSITORY, useClass: PrismaExamMessageRepository },
    { provide: MESSAGE_SHORTCUT_REPOSITORY, useClass: PrismaMessageShortcutRepository },
    { provide: CHAT_ATTACHMENT_STORAGE, useClass: ChatAttachmentStorageService },
    ...COMMAND_AND_QUERY_HANDLERS,
  ],
})
export class ChatModule {}
