import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { MESSAGE_SHORTCUT_REPOSITORY, type MessageShortcutRepositoryPort } from "../../ports/message-shortcut-repository.port.js";
import { MessageShortcut } from "../../../domain/message-shortcut.entity.js";
import { CreateMessageShortcutCommand } from "./create-message-shortcut.command.js";

/**
 * Creates one quick-reply chip for the caller's active clinic. Uppercased before checking or
 * storing -- "CONT" and "cont" are the same button to a nurse typing quickly, and the
 * `(tenantId, code)` unique index is case-sensitive at the database level, so leaving the
 * casing as typed would let two visually-identical codes collide unpredictably depending on
 * which one happened to be created first.
 *
 * `code` uniqueness is checked here, not left to the database constraint alone, so a
 * duplicate reports a clear `ConflictError` (via `MessageShortcut.assertCodeAvailable`)
 * instead of a raw Postgres unique-violation reaching the caller.
 */
@CommandHandler(CreateMessageShortcutCommand)
export class CreateMessageShortcutHandler implements ICommandHandler<CreateMessageShortcutCommand, MessageShortcut> {
  constructor(
    @Inject(MESSAGE_SHORTCUT_REPOSITORY) private readonly shortcuts: MessageShortcutRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: CreateMessageShortcutCommand): Promise<MessageShortcut> {
    const code = command.code.trim().toUpperCase();
    const existing = await this.shortcuts.findByTenantAndCode(command.tenantId, code);
    MessageShortcut.assertCodeAvailable(existing, code);

    const shortcut = await this.shortcuts.create({
      tenantId: command.tenantId,
      code,
      label: command.label.trim(),
      body: command.body.trim(),
      createdByUserId: command.actingUserId,
    });

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: command.tenantId,
        userId: command.actingUserId,
        sessionId: null,
        action: AuditAction.MESSAGE_SHORTCUT_CREATED,
        resourceType: "MessageShortcut",
        resourceId: shortcut.id,
        details: { code },
      })
    );

    return shortcut;
  }
}
