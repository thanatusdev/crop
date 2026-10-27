import type { AccessTokenClaims } from "@crop/shared";

export class WithdrawAgreementCommand {
  constructor(
    public readonly actor: AccessTokenClaims,
    public readonly agreementId: string
  ) {}
}
