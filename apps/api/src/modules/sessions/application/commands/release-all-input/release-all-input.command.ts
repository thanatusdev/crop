export class ReleaseAllInputCommand {
  constructor(
    public readonly sessionId: string,
    public readonly tenantId: string,
    public readonly requestedByUserId: string
  ) {}
}
