import { Inject } from "@nestjs/common";
import { EventsHandler, type IEventHandler } from "@nestjs/cqrs";
import { TenantType } from "@crop/shared";
import { TenantCreatedEvent } from "../../../tenants/application/events/tenant-created.event.js";
import { MESSAGE_SHORTCUT_REPOSITORY, type MessageShortcutRepositoryPort } from "../ports/message-shortcut-repository.port.js";

/**
 * Reacts to `TenantCreatedEvent` (see that event's own docstring for why `ChatModule` listens
 * for it rather than `TenantsModule` calling this directly) by seeding the six
 * `DEFAULT_MESSAGE_SHORTCUTS` into every newly created `CLINIC` tenant -- the live-code
 * counterpart to the `exam_chat_and_shortcuts` migration's own one-time backfill, which only
 * ever covered clinics that existed *before* that migration ran. `OPERATOR_PROVIDER`/
 * `PLATFORM` tenants are skipped: shortcuts are per-clinic (`MessageShortcutSchema`'s own
 * docstring), so an operating company or the platform tenant itself has no chat of its own to
 * seed defaults into.
 */
@EventsHandler(TenantCreatedEvent)
export class SeedDefaultShortcutsHandler implements IEventHandler<TenantCreatedEvent> {
  constructor(@Inject(MESSAGE_SHORTCUT_REPOSITORY) private readonly shortcuts: MessageShortcutRepositoryPort) {}

  async handle(event: TenantCreatedEvent): Promise<void> {
    if (event.type !== TenantType.CLINIC) return;
    await this.shortcuts.seedDefaults(event.tenantId);
  }
}
