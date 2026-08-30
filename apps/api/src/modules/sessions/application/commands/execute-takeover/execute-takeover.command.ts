import { UserRole } from "@crop/shared";

export class ExecuteTakeoverCommand {
  constructor(
    public readonly sessionId: string,
    public readonly tenantId: string,
    public readonly supervisorId: string,
    public readonly supervisorRole: UserRole
  ) {}
}
