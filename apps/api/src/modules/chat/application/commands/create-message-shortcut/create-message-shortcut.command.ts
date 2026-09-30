export class CreateMessageShortcutCommand {
  constructor(
    public readonly tenantId: string,
    public readonly actingUserId: string,
    public readonly code: string,
    public readonly label: string,
    public readonly body: string
  ) {}
}
