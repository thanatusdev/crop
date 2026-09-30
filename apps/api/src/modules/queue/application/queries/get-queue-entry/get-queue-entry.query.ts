import type { AccessTokenClaims } from "@crop/shared";

export class GetQueueEntryQuery {
  constructor(
    public readonly queueEntryId: string,
    public readonly tenantId: string,
    /** See GetEquipmentQuery.actor. */
    public readonly actor?: AccessTokenClaims
  ) {}
}
