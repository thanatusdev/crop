import type { AccessTokenClaims } from "@crop/shared";

export class StartSessionCommand {
  constructor(
    public readonly tenantId: string,
    public readonly operatorId: string,
    public readonly equipmentId: string,
    public readonly queueEntryId: string | null = null,
    /**
     * The full claims of the operator starting the session, forwarded to `GetEquipmentQuery` so
     * agreement scope is enforced here too.
     *
     * Carrying the whole claims object rather than just adding a `homeTenantId` field keeps the
     * agreement check in one place (`OperatorAccessService`) instead of spreading the "is this
     * caller cross-tenant" rule across every command that happens to need it. Optional so the seed
     * script, which dispatches this command directly through the CommandBus with no HTTP actor,
     * keeps working.
     */
    public readonly actor?: AccessTokenClaims
  ) {}
}
