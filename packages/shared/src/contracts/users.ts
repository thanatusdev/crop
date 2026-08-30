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
