export class GetUserByIdQuery {
  constructor(
    public readonly userId: string,
    public readonly requestingTenantId: string
  ) {}
}

