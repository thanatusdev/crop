export class StartSessionCommand {
  constructor(
    public readonly tenantId: string,
    public readonly operatorId: string,
    public readonly equipmentId: string,
    public readonly queueEntryId: string | null = null
  ) {}
}
