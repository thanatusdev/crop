import type { TenantType } from "@crop/shared";

/**
 * Published by `CreateTenantHandler` (and so also by every `CreateTenantCommand` dispatch --
 * including `infra/seeds/seed.ts`'s own two clinic-creation calls, which go through the same
 * command bus rather than writing Prisma rows directly) once a tenant is durably created.
 *
 * Exists purely so `ChatModule`'s `SeedDefaultShortcutsHandler` can seed the six default
 * quick-reply shortcuts (`DEFAULT_MESSAGE_SHORTCUTS`) into every new `CLINIC` tenant, without
 * `TenantsModule` needing to import `ChatModule` -- the identical anti-cycle shape
 * `QueueUpdatedEvent` already established for `QueueModule`/`SessionsModule`. Covers exactly
 * the gap the `exam_chat_and_shortcuts` migration's own one-time backfill left open: that
 * migration seeded every clinic that existed *before* the chat feature shipped; this event
 * seeds every one created *after*.
 */
export class TenantCreatedEvent {
  constructor(
    public readonly tenantId: string,
    public readonly type: TenantType
  ) {}
}
