import { evaluatePassword, PASSWORD_MIN_LENGTH, type PasswordRuleId } from "@crop/shared";
import { PasswordPolicyError, PasswordReuseError } from "../../../shared/domain/errors.js";
import type { PasswordHasherPort } from "./ports/password-hasher.port.js";
import type { UserRepositoryPort } from "./ports/user-repository.port.js";

/**
 * The two password-setting checks that can't live in a Zod schema, because both need data a
 * request body alone doesn't carry -- the account's own name/email (for
 * `noPersonalInfo`) and its password history (for reuse). Used by every handler that sets a
 * password: RegisterUserHandler, ResetPasswordHandler, ChangePasswordHandler, and
 * AdminResetPasswordHandler. `StrongPasswordSchema` (packages/shared/src/contracts/) still
 * covers length/case/digit/symbol at the HTTP boundary, before any of this ever runs --
 * these two exist for exactly the fifth rule and reuse, which that schema cannot express.
 */

const RULE_PHRASES_PT_BR: Record<PasswordRuleId, string> = {
  minLength: `ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres`,
  mixedCase: "combinar letras maiúsculas e minúsculas",
  digit: "incluir um número",
  symbol: "incluir um caractere especial",
  noPersonalInfo: "não conter seu nome, seu e-mail ou o nome do produto",
};

/** "a", "a e b", "a, b e c" -- how the rules read as one pt-BR sentence. */
function joinPtBr(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

export function assertPasswordPolicy(
  password: string,
  context: { email: string; firstName?: string | null; lastName?: string | null }
): void {
  const evaluation = evaluatePassword(password, context);
  if (!evaluation.ok) {
    throw new PasswordPolicyError(`A senha deve ${joinPtBr(evaluation.failed.map((rule) => RULE_PHRASES_PT_BR[rule]))}.`);
  }
}

/**
 * Not called for a brand-new registration -- there is no prior history to reuse yet (the
 * account's very first `PasswordHistory` row is inserted by `UserRepositoryPort.create`
 * itself, from the same password this would otherwise be checking against). Every other
 * password-setting path calls this.
 */
export async function assertPasswordNotReused(
  password: string,
  userId: string,
  deps: { users: UserRepositoryPort; hasher: PasswordHasherPort },
  historyDepth: number
): Promise<void> {
  const recentHashes = await deps.users.recentPasswordHashes(userId, historyDepth);
  for (const hash of recentHashes) {
    if (await deps.hasher.verify(hash, password)) {
      throw new PasswordReuseError("Esta senha foi usada recentemente nesta conta. Escolha uma senha diferente.");
    }
  }
}
