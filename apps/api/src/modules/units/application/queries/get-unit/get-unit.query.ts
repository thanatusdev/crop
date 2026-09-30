import type { AccessTokenClaims, UserRole } from "@crop/shared";

export class GetUnitQuery {
  constructor(
    public readonly unitId: string,
    public readonly requestingUserId: string,
    public readonly requestingTenantId: string,
    public readonly requestingRole: UserRole,
    /** See GetEquipmentQuery.actor. */
    public readonly actor?: AccessTokenClaims
  ) {}
}
