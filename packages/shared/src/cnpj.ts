/**
 * Brazil's CNPJ (Cadastro Nacional da Pessoa Jurídica) — a legal entity's tax id, and the
 * key this feature's matriz/filial derivation and clinic-uniqueness both rest on.
 *
 * Unlike a CEP (`CalendarDateSchema`'s sibling in `contracts/units.ts`, validated by format
 * only because there's no offline way to check one against Correios), a CNPJ carries a real,
 * self-contained check-digit algorithm — the two trailing digits are a deterministic
 * function of the other twelve. That means a typo'd CNPJ can actually be *rejected*, not
 * merely shaped correctly, which is worth doing precisely because nothing else in this
 * codebase can currently verify a CNPJ against any external registry either.
 */

/** Strips everything but digits. `"12.345.678/0001-90"` → `"12345678000190"`. */
export function normalizeCnpj(value: string): string {
  return value.replace(/\D/g, "");
}

/** `"12345678000190"` → `"12.345.678/0001-90"`. Assumes 14 digits; does not itself validate. */
export function formatCnpj(digits: string): string {
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

/**
 * The weighted mod-11 check-digit algorithm every real CNPJ satisfies. Computes both
 * trailing digits from the first twelve and compares -- the standard two-pass definition
 * (Receita Federal's own published algorithm), not a simplified approximation.
 */
function checkDigitsOf(twelveDigits: string): string {
  const digits = twelveDigits.split("").map(Number);

  function weightedMod11(values: number[], weights: readonly number[]): number {
    const sum = values.reduce((total, value, index) => total + value * weights[index]!, 0);
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  }

  const firstCheck = weightedMod11(digits, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const secondCheck = weightedMod11([...digits, firstCheck], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${firstCheck}${secondCheck}`;
}

/**
 * Format (14 digits) and check-digit validity, together. Also rejects every all-same-digit
 * string (`"00000000000000"`, `"11111111111111"`, ...): each of these would otherwise pass
 * the checksum for at least one value (the algorithm has no defense against a degenerate,
 * constant input), and none is a real, issuable CNPJ -- this is the standard extra guard
 * every real-world CNPJ validator adds for exactly that reason.
 */
export function isValidCnpj(value: string): boolean {
  const digits = normalizeCnpj(value);
  if (digits.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(digits)) return false;
  return checkDigitsOf(digits.slice(0, 12)) === digits.slice(12);
}

/**
 * The first 8 digits -- the root establishment number shared by every branch of the same
 * legal entity. `"12345678000190"` and `"12345678000283"` share the root `"12345678"`,
 * which is how "branches of this clinic" is computed with no new relationship column (see
 * `docs/architecture.md`'s own note on this feature's model). Does not itself validate;
 * pair with `isValidCnpj` first.
 */
export function cnpjRoot(digits: string): string {
  return digits.slice(0, 8);
}

/**
 * Digits 9-12 -- the establishment ("ordem") number. `"0001"` is always the matriz by
 * Receita Federal convention; any other value is a filial, numbered in registration order.
 */
export function cnpjBranchOrder(digits: string): string {
  return digits.slice(8, 12);
}

/** Whether this CNPJ is a matriz (establishment order `"0001"`), not a filial. */
export function isMatrizCnpj(digits: string): boolean {
  return cnpjBranchOrder(digits) === "0001";
}
