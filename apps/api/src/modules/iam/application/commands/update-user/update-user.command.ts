import type { UserRole } from "@crop/shared";

/**
 * The fields `PATCH /users/:id` may change -- see `UpdateUserRequestSchema`'s own docstring
 * in packages/shared for the full reasoning on what's included and, more importantly, what
 * (`email`) deliberately is not. `clinicTenantIds`, when present, is the *complete* desired
 * set including the user's own home tenant if the caller wants to spell it out -- `undefined`
 * mirrors "home tenant" implicitly either way, the same convention `RegisterUserCommand`'s
 * own `clinicTenantIds` already uses (its home tenant is filtered back out and always
 * re-added, so sending it or not makes no difference).
 */
export interface UpdateUserChanges {
  firstName?: string;
  lastName?: string;
  professionalRegistration?: string | null;
  role?: UserRole;
  clinicTenantIds?: string[];
}

export class UpdateUserCommand {
  constructor(
    public readonly targetUserId: string,
    public readonly actingAdminId: string,
    public readonly actingAdminTenantId: string,
    public readonly actingRole: UserRole,
    public readonly changes: UpdateUserChanges
  ) {}
}
