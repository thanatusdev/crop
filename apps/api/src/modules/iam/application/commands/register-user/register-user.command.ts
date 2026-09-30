import { UserRole } from "@crop/shared";

export class RegisterUserCommand {
  constructor(
    public readonly tenantId: string,
    public readonly email: string,
    public readonly role: UserRole,
    public readonly firstName: string,
    public readonly lastName: string,
    // Null for the seed script / bootstrap-superadmin.ts, where there is no human admin
    // acting -- see RegisterUserHandler's USER_CREATED audit dispatch, and `canGrantRole`'s
    // own docstring for why this also exempts them from the role-grant check.
    public readonly actingUserId: string | null = null,
    public readonly professionalRegistration: string | null = null,
    // The acting admin's own role, checked against `canGrantRole` (see roles.ts) -- e.g. a
    // CLINIC_ADMIN may only register NURSING accounts. Null has the same seed/bootstrap
    // exemption as `actingUserId`, and for the same reason: there is no acting admin.
    public readonly actingRole: UserRole | null = null,
    // Every clinic (CLINIC-type Tenant id) the new account should be linked to, beyond
    // `tenantId` itself (its home/active clinic). Required (non-empty) when
    // `requiresClinicAssignment(role)` is true -- see roles.ts. Ignored for every other
    // role, which still uses the single-tenant model `tenantId` alone always represented.
    public readonly clinicTenantIds: readonly string[] = [],
    // Mirrors the "Status: Ativo" toggle -- `false` creates the account already locked, for
    // an admin provisioning a user ahead of their start date without granting access yet.
    public readonly active: boolean = true,
    // Non-null only for the seed script / bootstrap-superadmin.ts, which already know the
    // account's real password and want it usable immediately -- simulating an
    // already-onboarded account, not a freshly-provisioned one (both auto-confirm MFA on
    // the user's behalf right afterward). Null is the HTTP path: no password is set here at
    // all, and the account cannot log in until its invitation link is redeemed (see
    // SendInvitationHandler / ActivateAccountHandler) -- the "Enviar Convite Seguro" flow,
    // replacing what used to be an admin-typed temp password.
    public readonly directActivation: { password: string } | null = null
  ) {}
}

export interface RegisterUserResult {
  userId: string;
  enrollmentToken: string;
  provisioningUri: string;
}
