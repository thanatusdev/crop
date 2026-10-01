import { Body, Controller, Get, Inject, Param, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  CHAT_ALLOWED_ROLES,
  ClinicDayStringSchema,
  CreateMessageShortcutRequestSchema,
  SendExamMessageRequestSchema,
  todayClinicDayString,
  type AccessTokenClaims,
  type CreateMessageShortcutRequest,
} from "@crop/shared";
import { ZodValidationPipe } from "../../../shared/infrastructure/http/zod-validation.pipe.js";
import { ValidationError } from "../../../shared/domain/errors.js";
import { JwtAuthGuard } from "../../iam/presentation/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../iam/presentation/guards/roles.guard.js";
import { Roles } from "../../iam/presentation/decorators/roles.decorator.js";
import { CurrentUser } from "../../iam/presentation/decorators/current-user.decorator.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../iam/application/ports/user-repository.port.js";
import { CHAT_ATTACHMENT_STORAGE, type ChatAttachmentStoragePort } from "../application/ports/chat-attachment-storage.port.js";
import { ListExamMessagesQuery } from "../application/queries/list-exam-messages/list-exam-messages.query.js";
import { GetExamMessageQuery } from "../application/queries/get-exam-message/get-exam-message.query.js";
import { ListMessageShortcutsQuery } from "../application/queries/list-message-shortcuts/list-message-shortcuts.query.js";
import { CreateMessageShortcutCommand } from "../application/commands/create-message-shortcut/create-message-shortcut.command.js";
import { SendExamMessageCommand } from "../application/commands/send-exam-message/send-exam-message.command.js";
import { ExamMessage } from "../domain/exam-message.entity.js";
import { MessageShortcut } from "../domain/message-shortcut.entity.js";
import { toExamMessageDto, toMessageShortcutDto } from "./chat.dto.js";

/** Images and one document type -- a photo of a wristband/requisition, or a signed PDF. Not
 * an open allow-anything upload: this chat is text-first, and a room's storage directory
 * (see `ChatAttachmentStorageService`) has no virus scanning or content sniffing behind it,
 * so the allow-list is enforced by declared mime type up front rather than trusting whatever
 * a browser happened to send. Sourced from `@crop/shared`'s `ALLOWED_DOCUMENT_MIME_TYPES` --
 * the one allow-list this app enforces anywhere a human can upload a file, shared with
 * `QueueController`'s exam-document upload, not a second copy that happens to agree today.*/
const ALLOWED_ATTACHMENT_MIME_TYPES: ReadonlySet<string> = new Set(ALLOWED_DOCUMENT_MIME_TYPES);

/**
 * The exam-support chat's REST surface. Sending moved here from the socket (see
 * `SendExamMessageRequestSchema`'s own docstring for why) -- `chat:equipment:join` is now the
 * socket's only remaining role, purely to receive `EXAM_MESSAGE_CREATED` live.
 *
 * `@Roles` uses the shared `CHAT_ALLOWED_ROLES` list (mirrors `QueueController`'s own
 * class-level set) so the REST surface and `CanAccessEquipmentChatHandler`'s socket-join
 * check can never drift apart -- see that constant's own docstring.
 */
@Controller("chat")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...CHAT_ALLOWED_ROLES)
export class ChatController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(CHAT_ATTACHMENT_STORAGE) private readonly attachments: ChatAttachmentStoragePort,
    private readonly config: ConfigService
  ) {}

  // `date` defaults to *today* here, unlike `GET /queue`'s own `date` (see
  // `ListExamMessagesQuery.day`'s own docstring for why the two routes differ on this) --
  // this route is new enough, and single-purpose enough, that "today" is the only sensible
  // default rather than "everything".
  @Get("messages")
  async listMessages(@CurrentUser() user: AccessTokenClaims, @Query("equipmentId") equipmentId?: string, @Query("date") date?: string) {
    if (!equipmentId) throw new ValidationError("equipmentId is required");
    if (date !== undefined && !ClinicDayStringSchema.safeParse(date).success) {
      throw new ValidationError("date must be YYYY-MM-DD");
    }
    const day = date ?? todayClinicDayString();
    const messages: ExamMessage[] = await this.queryBus.execute(new ListExamMessagesQuery(equipmentId, user.tenantId, user, day));

    const authorIds = [...new Set(messages.map((m) => m.authorUserId))];
    const names = authorIds.length > 0 ? await this.users.summarizeDisplayNames(authorIds) : {};
    return messages.map((m) => toExamMessageDto(m, names[m.authorUserId] ?? null));
  }

  /**
   * REST, not the socket -- see `SendExamMessageRequestSchema`'s own docstring for why. Body
   * fields arrive as multipart text fields (hence the manual `zod.parse` rather than
   * `ZodValidationPipe`, which expects a JSON body); the file, if any, is Multer's own
   * `UploadedFile`. `FileInterceptor`'s own `limits.fileSize` is a hard, statically-configured
   * ceiling (Nest resolves interceptor options at class-definition time, before
   * `ConfigService` exists -- the same "can't inject ConfigService here" constraint
   * `SessionsGateway`'s CORS fallback already documents); `CHAT_ATTACHMENT_MAX_BYTES` is
   * re-checked against the real, resolved config value inside the handler, so operators can
   * lower the limit without a redeploy touching this decorator.
   */
  @Post("messages")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 25 * 1024 * 1024 } }))
  async sendMessage(@CurrentUser() user: AccessTokenClaims, @Body() body: unknown, @UploadedFile() file?: Express.Multer.File) {
    const parsed = SendExamMessageRequestSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    if (!parsed.data.body.trim() && !file) {
      throw new ValidationError("A message needs either text or an attachment");
    }

    let attachment: { filename: string; mimeType: string; data: Buffer } | null = null;
    if (file) {
      const maxBytes = this.config.get<number>("CHAT_ATTACHMENT_MAX_BYTES", 10 * 1024 * 1024);
      if (file.size > maxBytes) {
        throw new ValidationError(`Attachment exceeds the ${Math.floor(maxBytes / (1024 * 1024))}MB limit`);
      }
      if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(file.mimetype)) {
        throw new ValidationError(`Attachment type "${file.mimetype}" is not allowed`);
      }
      attachment = { filename: file.originalname, mimeType: file.mimetype, data: file.buffer };
    }

    return this.commandBus.execute(new SendExamMessageCommand(parsed.data.equipmentId, user, parsed.data.body.trim(), attachment));
  }

  /** Loads the owning message first and re-checks tenancy/scope through its equipment --
   * the same "never take a path from the URL" discipline
   * `SessionsController.getSnapshotImage` already follows for `SessionSnapshot.imagePath`. */
  @Get("messages/:id/attachment")
  async getAttachment(@CurrentUser() user: AccessTokenClaims, @Param("id") id: string, @Res() res: Response): Promise<void> {
    const message: ExamMessage = await this.queryBus.execute(new GetExamMessageQuery(id, user.tenantId, user));
    if (!message.attachment) throw new ValidationError("This message has no attachment");

    const data = await this.attachments.read(message.attachment.path);
    res
      .type(message.attachment.mimeType)
      .set("Content-Disposition", `inline; filename="${encodeURIComponent(message.attachment.filename)}"`)
      .send(data);
  }

  @Get("shortcuts")
  async listShortcuts(@CurrentUser() user: AccessTokenClaims) {
    const shortcuts: MessageShortcut[] = await this.queryBus.execute(new ListMessageShortcutsQuery(user.tenantId));
    return shortcuts.map(toMessageShortcutDto);
  }

  @Post("shortcuts")
  async createShortcut(
    @CurrentUser() user: AccessTokenClaims,
    @Body(new ZodValidationPipe(CreateMessageShortcutRequestSchema)) body: CreateMessageShortcutRequest
  ) {
    const shortcut: MessageShortcut = await this.commandBus.execute(
      new CreateMessageShortcutCommand(user.tenantId, user.sub, body.code, body.label, body.body)
    );
    return toMessageShortcutDto(shortcut);
  }
}
