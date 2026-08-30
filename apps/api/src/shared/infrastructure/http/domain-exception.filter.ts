import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from "../../domain/errors.js";

const STATUS_BY_ERROR = new WeakMap<Function, HttpStatus>([
  [NotFoundError, HttpStatus.NOT_FOUND],
  [ConflictError, HttpStatus.CONFLICT],
  [ForbiddenError, HttpStatus.FORBIDDEN],
  [ValidationError, HttpStatus.BAD_REQUEST],
  [UnauthorizedError, HttpStatus.UNAUTHORIZED],
  [TooManyRequestsError, HttpStatus.TOO_MANY_REQUESTS],
]);

/**
 * Translates domain errors into HTTP responses at the presentation boundary. This is the only
 * place `DomainError` subclasses are aware an HTTP status code exists -- application and
 * domain code just throw the semantic error and never touch `@nestjs/common`.
 */
@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: DomainError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = STATUS_BY_ERROR.get(exception.constructor) ?? HttpStatus.INTERNAL_SERVER_ERROR;
    response.status(status).json({ code: exception.code, message: exception.message });
  }
}
