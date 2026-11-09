import type { UserRole } from "@crop/shared";

export class AdminResetPasswordCommand {
  constructor(
    public readonly targetUserId: string,
    public readonly newPassword: string,
    public readonly actingAdminId: string,
    public readonly actingAdminTenantId: string,
    public readonly actingRole: UserRole
  ) {}
}
