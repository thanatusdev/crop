export class EndSessionCommand {
  constructor(
    public readonly sessionId: string,
    public readonly tenantId: string,
    public readonly requestedByUserId: string
  ) {}
}
