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
