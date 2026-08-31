import { UserRole } from "@crop/shared";

export class RegisterUserCommand {
  constructor(
    public readonly tenantId: string,
    public readonly email: string,
    public readonly password: string,
    public readonly role: UserRole,
    // Null for the seed script / bootstrap-superadmin.ts, where there is no human admin
    // acting -- see RegisterUserHandler's USER_CREATED audit dispatch.
    public readonly actingUserId: string | null = null
  ) {}
}

export interface RegisterUserResult {
  userId: string;
  enrollmentToken: string;
  provisioningUri: string;
}
