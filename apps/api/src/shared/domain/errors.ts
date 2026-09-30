/**
 * Domain-level errors. Framework-agnostic on purpose: nothing in `domain` or `application`
 * may import from `@nestjs/common`, so these are plain classes, mapped to HTTP status codes
 * only at the presentation layer (see shared/infrastructure/http/domain-exception.filter.ts).
 */

export abstract class DomainError extends Error {
  abstract readonly code: string;
}

export class NotFoundError extends DomainError {
  readonly code = "NOT_FOUND";
  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`);
  }
}

export class ConflictError extends DomainError {
  readonly code = "CONFLICT";
}

export class ForbiddenError extends DomainError {
  readonly code = "FORBIDDEN";
}

export class ValidationError extends DomainError {
  readonly code = "VALIDATION_ERROR";
}

export class UnauthorizedError extends DomainError {
  readonly code = "UNAUTHORIZED";
}

export class TooManyRequestsError extends DomainError {
  readonly code = "TOO_MANY_REQUESTS";
}

/**
 * The password itself fails `evaluatePassword` (@crop/shared) -- too short, missing a
 * character class, or contains the account's own name/email/brand. Distinct code from
 * `ValidationError`, not reused: the frontend (pt-BR) needs to render its own copy rather
 * than this class's English message, and a stable `code` is what lets it choose the right
 * string instead of pattern-matching prose. See `enforce-password-policy.ts`.
 */
export class PasswordPolicyError extends DomainError {
  readonly code = "PASSWORD_POLICY_VIOLATION";
}

/**
 * The password is otherwise valid but matches one of the account's last
 * `PASSWORD_HISTORY_DEPTH` password hashes -- the one policy failure a client can never
 * predict on its own (unlike length/case/digit/symbol/personal-info, all checkable without
 * a server round trip), so it always needs its own distinct code to render correctly.
 */
export class PasswordReuseError extends DomainError {
  readonly code = "PASSWORD_REUSED";
}
