import type { AccessTokenClaims } from "@crop/shared";

export class CreateQueueEntryCommand {
  constructor(
    public readonly tenantId: string,
    public readonly actingUserId: string,
    public readonly equipmentId: string,
    public readonly patientFirstName: string,
    public readonly scheduledAt: Date | null,
    /** See GetEquipmentQuery.actor. */
    public readonly actor?: AccessTokenClaims
  ) {}
}
