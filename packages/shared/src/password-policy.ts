/**
 * Password rules, shared between the API (enforcement) and the browser (live checklist/
 * strength meter) so the two can never disagree about what counts as a strong password --
 * see docs/architecture.md for why this had to be one implementation, not two.
 *
 * Deliberately does NOT check reuse against password history: that requires the user's
 * stored hash history (Postgres), which this pure, dependency-free function has no access
 * to and shouldn't -- see UserRepositoryPort.recentPasswordHashes /
 * ResetPasswordHandler/etc. for that check, which can only ever run server-side.
 */

export const PASSWORD_MIN_LENGTH = 8;
/** Advisory only -- see `meetsRecommendedLength` below. Never blocks submission; it only
 * feeds the strength meter, matching the mock's "8 caracteres (10+ rec.)" wording. */
export const PASSWORD_RECOMMENDED_LENGTH = 10;

/** Words nobody's password should contain regardless of who they are -- the product/brand
 * names this account lives under. Deliberately NOT the email domain (e.g. "health" from
 * `@alpha.crop.health`) -- that would reject far more than the mock's own "não deve conter
 * seu primeiro nome, sobrenome ou 'radlink'" describes. */
const BRAND_DENYLIST = ["radlink", "crop"];

/** The four checklist rules the mock draws as always-checkable (length/case/digit/symbol),
 * plus the fifth, context-dependent one (personal info). Order matches the mock's own
 * checklist layout. */
export type PasswordRuleId = "minLength" | "mixedCase" | "digit" | "symbol" | "noPersonalInfo";

export interface PasswordEvaluationContext {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}

export interface PasswordEvaluation {
  satisfied: PasswordRuleId[];
  failed: PasswordRuleId[];
  ok: boolean;
  /** Drives the strength meter's top segment / the "10+ rec." hint -- never gates `ok`. */
  meetsRecommendedLength: boolean;
}

/**
 * Tokens a password must not contain, derived from things the account owner is presumed to
 * know and an attacker guessing from a leaked email/name plausibly would too. Tokens under
 * 3 characters are dropped (e.g. the "dr." in `dr.ricardo.silva@...` would otherwise block
 * almost every password purely by chance), and purely-numeric tokens are dropped too -- a
 * name is never all digits, but a random fixture id fragment can be, and that's exactly the
 * kind of accidental collision this function must never produce (see
 * packages/shared/tests/password-policy.test.ts for the case this guards against: a UUID
 * segment inside a generated test email coincidentally matching the digits in a fixture
 * password).
 */
function personalTokens(context: PasswordEvaluationContext): string[] {
  const localPart = context.email.split("@")[0] ?? "";
  const raw = [...localPart.split(/[._+-]/), context.firstName, context.lastName];
  return raw
    .filter((token): token is string => !!token)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3 && /[a-z]/.test(token));
}

function containsPersonalInfo(password: string, context: PasswordEvaluationContext): boolean {
  const lower = password.toLowerCase();
  const tokens = [...personalTokens(context), ...BRAND_DENYLIST];
  return tokens.some((token) => lower.includes(token));
}

export function evaluatePassword(password: string, context: PasswordEvaluationContext): PasswordEvaluation {
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /\d/.test(password);
  // Intentionally broad (anything that isn't a letter or digit), not a fixed allowlist like
  // `@#$%` (the mock's own example set) -- narrowing it would reject legitimate punctuation
  // for no security benefit and would need updating every time someone picks a symbol the
  // allowlist didn't anticipate.
  const hasSymbol = /[^A-Za-z0-9]/.test(password);

  const checks: Record<PasswordRuleId, boolean> = {
    minLength: password.length >= PASSWORD_MIN_LENGTH,
    mixedCase: hasUpper && hasLower,
    digit: hasDigit,
    symbol: hasSymbol,
    noPersonalInfo: !containsPersonalInfo(password, context),
  };

  const satisfied = (Object.keys(checks) as PasswordRuleId[]).filter((id) => checks[id]);
  const failed = (Object.keys(checks) as PasswordRuleId[]).filter((id) => !checks[id]);

  return {
    satisfied,
    failed,
    ok: failed.length === 0,
    meetsRecommendedLength: password.length >= PASSWORD_RECOMMENDED_LENGTH,
  };
}
