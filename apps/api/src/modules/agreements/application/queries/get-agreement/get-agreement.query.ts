export class GetAgreementQuery {
  constructor(
    public readonly agreementId: string,
    /** `null` skips the party check -- `PLATFORM_ADMIN` only, same as `ListAgreementsQuery`. */
    public readonly tenantId: string | null
  ) {}
}
