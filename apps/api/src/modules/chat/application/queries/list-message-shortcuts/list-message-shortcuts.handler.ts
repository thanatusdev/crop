import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import { MESSAGE_SHORTCUT_REPOSITORY, type MessageShortcutRepositoryPort } from "../../ports/message-shortcut-repository.port.js";
import { MessageShortcut } from "../../../domain/message-shortcut.entity.js";
import { ListMessageShortcutsQuery } from "./list-message-shortcuts.query.js";

/** No agreement-scope check here, unlike `ListExamMessagesHandler`: a shortcut is not tied to
 * any one piece of equipment, only to the caller's own active clinic tenant (`user.tenantId`,
 * which for a contracted operator is already the clinic they switched into -- see
 * `SwitchActiveClinicHandler`) -- so tenancy alone is the whole check, the same as any other
 * `user.tenantId`-scoped read in this codebase. */
@QueryHandler(ListMessageShortcutsQuery)
export class ListMessageShortcutsHandler implements IQueryHandler<ListMessageShortcutsQuery, MessageShortcut[]> {
  constructor(@Inject(MESSAGE_SHORTCUT_REPOSITORY) private readonly shortcuts: MessageShortcutRepositoryPort) {}

  async execute(query: ListMessageShortcutsQuery): Promise<MessageShortcut[]> {
    return this.shortcuts.listActiveByTenant(query.tenantId);
  }
}
