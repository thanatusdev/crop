import type { AccessTokenClaims } from "@crop/shared";

export class RespondToAgreementCommand {
  constructor(
    public readonly actor: AccessTokenClaims,
    public readonly agreementId: string,
    /** `true` accepts (-> ACTIVE), `false` rejects (-> REJECTED). One command rather than two so
     * the "only the other side may answer" rule cannot drift between them. */
    public readonly accept: boolean
  ) {}
}
