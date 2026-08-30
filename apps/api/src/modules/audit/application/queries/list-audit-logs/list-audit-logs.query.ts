export class ListAuditLogsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly sessionId?: string,
    public readonly userId?: string,
    public readonly limit = 100,
    public readonly offset = 0
  ) {}
}
