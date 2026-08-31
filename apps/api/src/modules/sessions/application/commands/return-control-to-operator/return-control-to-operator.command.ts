import { UserRole } from "@crop/shared";

export class ReturnControlToOperatorCommand {
  constructor(
    public readonly sessionId: string,
    public readonly tenantId: string,
    public readonly actingUserId: string,
    public readonly actingUserRole: UserRole
  ) {}
}
