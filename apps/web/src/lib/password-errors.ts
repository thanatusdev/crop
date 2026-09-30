import { ApiError } from "./api-client.js";

/**
 * Maps the two password-policy error codes the API can return (see
 * apps/api/src/shared/domain/errors.ts's `PasswordPolicyError`/`PasswordReuseError`) to
 * translated copy. Both RecoveryPage's reset form and ForcePasswordChangePage hit the same
 * two failure modes against different endpoints, so this lives here once rather than twice.
 * Anything else (a real network failure, a code neither screen anticipated) falls back to a
 * generic message rather than surfacing the API's own English text on a pt-BR page.
 */
export function translatePasswordError(err: unknown, t: (key: "password:policyError" | "password:reusedError" | "password:genericError") => string): string {
  if (err instanceof ApiError) {
    if (err.code === "PASSWORD_POLICY_VIOLATION") return t("password:policyError");
    if (err.code === "PASSWORD_REUSED") return t("password:reusedError");
  }
  return t("password:genericError");
}
