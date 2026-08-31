export class CreateQueueEntryCommand {
  constructor(
    public readonly tenantId: string,
    public readonly actingUserId: string,
    public readonly equipmentId: string,
    public readonly patientFirstName: string,
    public readonly scheduledAt: Date | null
  ) {}
}
