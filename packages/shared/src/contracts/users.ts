import { z } from "zod";
import { UserRole } from "../enums.js";
import { ASSIGNABLE_ROLES, requiresClinicAssignment } from "../roles.js";
import { StrongPasswordSchema } from "./password.js";

/**
 * Deliberately omits `passwordHash` and `mfaSecret` -- this is what an admin's "manage
 * users" view is allowed to see, not a raw row dump. `locked`/`mfaEnrolled` are derived
 * booleans, not the underlying `lockedAt`/`mfaEnabledAt` timestamps: an admin needs to know
 * *whether*, not *exactly when*, for this view. `firstName`/`lastName` are nullable --
 * historical accounts predate those columns (see schema.prisma's own comment); `mustChangePassword`
 * lets an admin see at a glance whether a temp password they (or registration) issued is
 * still unclaimed. `activated` is the invitation-flow counterpart: false means the account
 * was registered but nobody has redeemed its invitation link yet (see
 * `ActivateAccountRequestSchema`), distinct from `mustChangePassword`, which only applies
 * once an account is already activated. `clinicTenantIds` is every clinic (`Tenant`) this
 * user can reach -- for the clinic-side roles (`CLINIC_ADMIN`/`LOCAL_SUPERVISOR`/`NURSING`)
 * this is the multi-clinic membership list; for every other role it's just `[tenantId]`,
 * the single-tenant model those roles still use.
 */
export const UserSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  email: z.string().email(),
  role: z.nativeEnum(UserRole),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  professionalRegistration: z.string().nullable(),
  mfaEnrolled: z.boolean(),
  locked: z.boolean(),
  mustChangePassword: z.boolean(),
  activated: z.boolean(),
  clinicTenantIds: z.array(z.string().uuid()),
});
export type UserDto = z.infer<typeof UserSchema>;

/**
 * Same policy as every other password-*setting* path (see `StrongPasswordSchema`) -- this is
 * an admin setting a new credential on a user's behalf (lost password, suspected
 * compromise), not self-service registration, but the strength floor is no lower just
 * because an admin is the one typing it in. `noPersonalInfo` and reuse still apply too, just
 * not expressible in this schema -- see AdminResetPasswordHandler.
 */
export const AdminResetPasswordRequestSchema = z.object({
  newPassword: StrongPasswordSchema,
});
export type AdminResetPasswordRequest = z.infer<typeof AdminResetPasswordRequestSchema>;

/**
 * `role` deliberately excludes PLATFORM_ADMIN: RegisterUserCommand always creates the new
 * account inside the *creating admin's own tenant* (see UsersController), and a
 * tenant-scoped PLATFORM_ADMIN is a contradiction in terms -- that role means "operates
 * across every tenant," not "operates within Clinica Alpha." The seed script follows the
 * same rule (it never mints one either). Creating a genuine platform-level operator account
 * isn't a tenant-admin action at all and isn't supported through this endpoint.
 *
 * `ASSIGNABLE_ROLES` (see `roles.ts`) spans both organization types -- CLINIC_ADMIN,
 * LOCAL_SUPERVISOR, NURSING, LOCAL_IT for a CLINIC tenant; OPERATOR_ADMIN,
 * OPERATIONAL_SUPERVISOR, OPERATOR for an OPERATOR_PROVIDER tenant; AUDITOR for either. This
 * schema does not itself check the *target* tenant's type, nor who may grant which role to
 * whom -- both are enforced by `RegisterUserHandler` (`isRoleAllowedInTenantType` and
 * `canGrantRole` respectively), which is where the tenant is actually loaded.
 *
 * There is no password field anymore: account creation no longer sets a credential
 * directly. `POST /users` sends the new account a secure, single-use, time-limited
 * invitation link instead (see `ActivateAccountRequestSchema`) -- the "Enviar Convite
 * Seguro" flow. The new user chooses their own first password when they redeem it; MFA
 * enrollment still happens on their own first login afterward exactly as before.
 *
 * `tenantId` is the *legacy* single-tenant path, unchanged from before this feature and
 * still how the roles it doesn't mention (OPERATOR_ADMIN/OPERATIONAL_SUPERVISOR/OPERATOR/
 * AUDITOR/LOCAL_IT) are scoped: optional, CLINIC_ADMIN-invisible, honored only when the
 * caller is PLATFORM_ADMIN, silently ignored (falling back to the caller's own tenant)
 * otherwise. `clinicTenantIds` is the *new* multi-clinic path for the three roles this
 * feature is actually about -- required (at least one) exactly when `requiresClinicAssignment(role)`
 * is true, and validated as a real business rule (not just "well-formed") in
 * `RegisterUserHandler`: every id must be an active CLINIC tenant, must be one the acting
 * Manager already belongs to (unless the caller is PLATFORM_ADMIN), and -- for
 * LOCAL_SUPERVISOR specifically -- must already have a CLINIC_ADMIN of its own ("A
 * Supervisor is linked to the clinic(s) of the responsible Manager").
 *
 * `firstName`/`lastName` are required here even though they're nullable on `User` itself --
 * every *new* account gets them from now on, so the null set (historical rows only) only
 * ever shrinks. They exist so the password-policy "no personal info" check
 * (`packages/shared/src/password-policy.ts`) has something to check against beyond the
 * email; the identity-card mock this was built for shows no display name anywhere, so that
 * check is the only reason these fields exist at all. `professionalRegistration` is
 * optional free text (e.g. "CRBM 14.820") -- the prefix varies by profession and nothing has
 * specified that taxonomy, so this is deliberately one opaque string, not a council-enum.
 *
 * `active` mirrors the mock's "Status: Ativo" toggle -- `false` registers the account
 * already locked (see `RegisterUserHandler`), for an admin who wants to provision a user
 * ahead of their actual start date without granting login access yet.
 */
export const CreateUserRequestSchema = z
  .object({
    email: z.string().email(),
    role: z.enum(ASSIGNABLE_ROLES as [UserRole, ...UserRole[]]),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    professionalRegistration: z.string().min(1).optional(),
    tenantId: z.string().uuid().optional(),
    clinicTenantIds: z.array(z.string().uuid()).optional(),
    active: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (requiresClinicAssignment(value.role) && (!value.clinicTenantIds || value.clinicTenantIds.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clinicTenantIds"],
        message: `role ${value.role} requires at least one clinicTenantId`,
      });
    }
  });
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;
