export class AssignSessionPatientCommand {
  constructor(
    public readonly sessionId: string,
    public readonly tenantId: string,
    public readonly requestedByUserId: string,
    public readonly queueEntryId: string
  ) {}
}
