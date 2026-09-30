import type { AccessTokenClaims } from "@crop/shared";

export class UpdateTeleoperationNotesCommand {
  constructor(
    public readonly tenantId: string,
    public readonly actingUserId: string,
    public readonly queueEntryId: string,
    public readonly teleoperationNotes: string,
    /** See GetEquipmentQuery.actor. */
    public readonly actor?: AccessTokenClaims
  ) {}
}
