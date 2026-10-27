import { z } from "zod";
import { PASSWORD_MIN_LENGTH } from "../password-policy.js";

/**
 * The four context-free rules from `evaluatePassword` (length/case/digit/symbol), as a Zod
 * schema, used on the three password-*setting* endpoints so a weak password is rejected
 * before a single database read. The fifth rule (`noPersonalInfo`, which needs the loaded
 * account) and reuse prevention (which needs password history) can't be expressed here --
 * see `apps/api/src/modules/iam/application/enforce-password-policy.ts` for those two.
 *
 * Deliberately NOT applied to `LoginRequestSchema.password` (contracts/auth.ts), which stays
 * a bare `min(8)` -- strengthening it would reject a wrong password with a `400` instead of
 * the enumeration-safe `401` LoginHandler is built around, and would invalidate every
 * existing credential that predates this policy. This schema is for *choosing* a password,
 * never for *checking* one.
 */
export const StrongPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .refine((value) => /[A-Z]/.test(value) && /[a-z]/.test(value), "A senha deve conter letras maiúsculas e minúsculas")
  .refine((value) => /\d/.test(value), "A senha deve conter ao menos um dígito")
  .refine((value) => /[^A-Za-z0-9]/.test(value), "A senha deve conter ao menos um caractere especial");
