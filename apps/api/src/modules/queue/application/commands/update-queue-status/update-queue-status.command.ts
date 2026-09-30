import type { AccessTokenClaims, QueueStatus } from "@crop/shared";

export class UpdateQueueStatusCommand {
  constructor(
    public readonly tenantId: string,
    public readonly actingUserId: string,
    public readonly queueEntryId: string,
    public readonly status: QueueStatus,
    /** See GetEquipmentQuery.actor. */
    public readonly actor?: AccessTokenClaims
  ) {}
}
