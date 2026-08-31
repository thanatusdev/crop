import { z } from "zod";
import { UserRole } from "../enums.js";

/**
 * Deliberately omits `passwordHash` and `mfaSecret` -- this is what an admin's "manage
 * users" view is allowed to see, not a raw row dump. `locked`/`mfaEnrolled` are derived
 * booleans, not the underlying `lockedAt`/`mfaEnabledAt` timestamps: an admin needs to know
 * *whether*, not *exactly when*, for this view.
 */
export const UserSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  email: z.string().email(),
  role: z.nativeEnum(UserRole),
  mfaEnrolled: z.boolean(),
  locked: z.boolean(),
});
export type UserDto = z.infer<typeof UserSchema>;

/**
 * Same minimum length as `LoginRequestSchema`'s password field (see contracts/auth.ts) --
 * this is an admin setting a new credential on a user's behalf (lost password, suspected
 * compromise), not self-service registration, but the strength floor shouldn't be any lower
 * just because an admin is the one typing it in.
 */
export const AdminResetPasswordRequestSchema = z.object({
  newPassword: z.string().min(8),
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
 * There is no `POST /auth/register` or mailer anywhere in this codebase (see
 * docs/architecture.md's "Account lockout and admin-forced password reset" section) -- the
 * admin sets this password directly and relays it to the new user out of band (Slack, in
 * person, whatever your clinic already uses for onboarding). The new user's *own* first
 * login already handles MFA enrollment from there: LoginHandler re-derives a fresh
 * `provisioningUri` from the stored `mfaSecret` whenever `mfaEnabledAt` is still null, and
 * LoginPage's existing "enroll" step renders it -- nothing new was needed for that part.
 */
export const CreateUserRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum([UserRole.CLINIC_ADMIN, UserRole.SUPERVISOR, UserRole.OPERATOR, UserRole.AUDITOR]),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;
