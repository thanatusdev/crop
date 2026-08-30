export class CaptureSessionSnapshotCommand {
  constructor(
    public readonly sessionId: string,
    public readonly tenantId: string,
    public readonly equipmentId: string
  ) {}
}
