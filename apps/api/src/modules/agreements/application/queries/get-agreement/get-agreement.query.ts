export class GetAgreementQuery {
  constructor(
    public readonly agreementId: string,
    public readonly tenantId: string
  ) {}
}
