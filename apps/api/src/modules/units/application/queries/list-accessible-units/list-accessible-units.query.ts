import type { AccessTokenClaims, UserRole } from "@crop/shared";

/** Backs `GET /units?scope=all` -- every unit across every clinic the caller can reach. */
export class ListAccessibleUnitsQuery {
  constructor(
    public readonly requestingUserId: string,
    public readonly requestingTenantId: string,
    public readonly requestingRole: UserRole,
    /** See GetEquipmentQuery.actor. */
    public readonly actor?: AccessTokenClaims
  ) {}
}
