import type { AccessTokenClaims } from "@crop/shared";

export class ProposeAgreementCommand {
  constructor(
    public readonly actor: AccessTokenClaims,
    /** The counterparty. Which of the two this is depends on the actor's own tenant type, and the
     * handler derives its own side from the token rather than the body -- so neither party can open
     * a contract on someone else's behalf. */
    public readonly counterpartyTenantId: string,
    public readonly unitIds: string[],
    public readonly equipmentIds: string[]
  ) {}
}
