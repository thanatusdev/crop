import { z } from "zod";
import { UserRole } from "../enums.js";
import { StrongPasswordSchema } from "./password.js";

/**
 * What `GET /auth/invitation?token=` returns for a still-good invitation token -- the
 * unauthenticated preview a freshly-invited user sees before choosing their own password,
 * same shape and reasoning as `PasswordResetValidateResponseSchema`: only the server knows
 * whether the token was already redeemed, so without this a spent link would render a
 * fully working activation form that only fails on submit.
 */
export const InvitationPreviewSchema = z.object({
  email: z.string().email(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  role: z.nativeEnum(UserRole),
  professionalRegistration: z.string().nullable(),
  expiresAt: z.string().datetime(),
});
export type InvitationPreview = z.infer<typeof InvitationPreviewSchema>;

/**
 * Redeems an invitation token, setting the account's first real password -- the
 * replacement for an admin typing a temp password directly (see `CreateUserRequestSchema`'s
 * own docstring for why that path is gone). No current password to check, same reasoning as
 * `ChangePasswordRequestSchema`: nobody has ever set one on this account before.
 */
export const ActivateAccountRequestSchema = z.object({
  token: z.string().min(1),
  newPassword: StrongPasswordSchema,
});
export type ActivateAccountRequest = z.infer<typeof ActivateAccountRequestSchema>;
