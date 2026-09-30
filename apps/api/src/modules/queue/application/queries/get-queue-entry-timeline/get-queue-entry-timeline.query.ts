import type { AccessTokenClaims } from "@crop/shared";

/** `GET /queue/:id/timeline` -- the nursing screen's per-exam activity panel. See
 * `QueueTimelineEntrySchema`'s own docstring in packages/shared for why this is a
 * resource-scoped route on QueueController rather than a widening of AuditController's
 * `@Roles` (which deliberately excludes NURSING). */
export class GetQueueEntryTimelineQuery {
  constructor(
    public readonly queueEntryId: string,
    public readonly tenantId: string,
    /** See GetEquipmentQuery.actor. */
    public readonly actor?: AccessTokenClaims
  ) {}
}
