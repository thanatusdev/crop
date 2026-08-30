export class GetSessionQuery {
  constructor(
    public readonly sessionId: string,
    public readonly tenantId: string
  ) {}
}

