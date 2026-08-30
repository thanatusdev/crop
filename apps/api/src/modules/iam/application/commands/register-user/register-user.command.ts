import { UserRole } from "@crop/shared";

export class RegisterUserCommand {
  constructor(
    public readonly tenantId: string,
    public readonly email: string,
    public readonly password: string,
    public readonly role: UserRole
  ) {}
}

export interface RegisterUserResult {
  userId: string;
  enrollmentToken: string;
  provisioningUri: string;
}
