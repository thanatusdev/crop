import type { AccessTokenClaims } from "@crop/shared";

export class GetEquipmentQuery {
  constructor(
    public readonly equipmentId: string,
    public readonly tenantId: string,
    /**
     * The HTTP caller, when there is one. Present means "also check this actor's agreement scope"
     * (see `OperatorAccessService`); absent means an internal caller acting on nobody's behalf --
     * the health poller, the snapshot scheduler, the idle-session sweeper -- for which there is no
     * contract to evaluate and refusing would simply break a background job.
     *
     * Optional rather than required so that adding contract scoping did not force every internal
     * call site to invent an actor, which is precisely how a check like this ends up being passed a
     * synthetic "system" identity that quietly satisfies it everywhere.
     */
    public readonly actor?: AccessTokenClaims
  ) {}
}
