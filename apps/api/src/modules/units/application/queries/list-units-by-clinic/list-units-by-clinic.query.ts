import type { AccessTokenClaims, UserRole } from "@crop/shared";

export class ListUnitsByClinicQuery {
  constructor(
    public readonly clinicTenantId: string,
    // Both null for the seed/bootstrap exemption -- see ClinicAccessChecker's own
    // docstring. A real HTTP caller always supplies both together.
    public readonly requestingUserId: string | null = null,
    public readonly requestingTenantId: string | null = null,
    public readonly requestingRole: UserRole | null = null,
    /** See GetEquipmentQuery.actor -- narrows the result to what this caller's agreement scope
     * covers, when they're reaching this clinic cross-tenant. */
    public readonly actor?: AccessTokenClaims
  ) {}
}
