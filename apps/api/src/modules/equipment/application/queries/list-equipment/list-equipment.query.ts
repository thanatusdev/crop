import type { AccessTokenClaims } from "@crop/shared";

export class ListEquipmentQuery {
  constructor(
    public readonly tenantId: string,
    /** See `GetEquipmentQuery.actor`. On this query the actor causes *filtering* rather than a
     * refusal: a contracted operator whose agreement covers one of three rooms should see that one
     * room, not an error. */
    public readonly actor?: AccessTokenClaims
  ) {}
}
