import type { AccessTokenClaims } from "@crop/shared";

export class SetAgreementScopeCommand {
  constructor(
    public readonly actor: AccessTokenClaims,
    public readonly agreementId: string,
    public readonly unitIds: string[],
    public readonly equipmentIds: string[]
  ) {}
}
