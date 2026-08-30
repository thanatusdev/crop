export class PrintTextCommand {
  constructor(
    public readonly sessionId: string,
    public readonly tenantId: string,
    public readonly equipmentId: string,
    public readonly userId: string,
    public readonly keymap: string,
    public readonly text: string
  ) {}
}
