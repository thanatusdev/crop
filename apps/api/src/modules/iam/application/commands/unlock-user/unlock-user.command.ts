import type { UserRole } from "@crop/shared";

export class UnlockUserCommand {
  constructor(
    public readonly targetUserId: string,
    public readonly actingAdminId: string,
    public readonly actingAdminTenantId: string,
    public readonly actingRole: UserRole
  ) {}
}
