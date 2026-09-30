import type { AccessTokenClaims } from "@crop/shared";

export class RevokeAgreementCommand {
  constructor(
    public readonly actor: AccessTokenClaims,
    public readonly agreementId: string
  ) {}
}
