import type { TenantType } from "@crop/shared";

export class CreateTenantCommand {
  constructor(
    public readonly name: string,
    public readonly type: TenantType,
    // Null for the seed script / bootstrap-superadmin.ts, where there is no human admin
    // acting yet -- same reasoning as RegisterUserCommand.actingUserId.
    public readonly actingAdminId: string | null = null
  ) {}
}
