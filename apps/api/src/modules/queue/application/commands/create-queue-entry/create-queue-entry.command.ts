export class CreateQueueEntryCommand {
  constructor(
    public readonly equipmentId: string,
    public readonly patientFirstName: string,
    public readonly scheduledAt: Date | null
  ) {}
}
