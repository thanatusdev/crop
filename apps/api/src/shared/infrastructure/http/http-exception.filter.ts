import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Response } from "express";

const MESSAGE_BY_STATUS: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: "Requisição inválida.",
  [HttpStatus.UNAUTHORIZED]: "Sua sessão expirou ou é inválida. Entre novamente.",
  [HttpStatus.FORBIDDEN]: "Você não tem permissão para realizar esta ação.",
  [HttpStatus.NOT_FOUND]: "Recurso não encontrado.",
  [HttpStatus.METHOD_NOT_ALLOWED]: "Operação não permitida.",
  [HttpStatus.CONFLICT]: "A operação conflita com o estado atual do registro.",
  [HttpStatus.PAYLOAD_TOO_LARGE]: "O arquivo enviado excede o tamanho máximo permitido.",
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: "Tipo de arquivo não suportado.",
  [HttpStatus.UNPROCESSABLE_ENTITY]: "Não foi possível processar os dados enviados.",
  [HttpStatus.TOO_MANY_REQUESTS]: "Muitas tentativas em pouco tempo. Aguarde um momento e tente novamente.",
  [HttpStatus.INTERNAL_SERVER_ERROR]: "Erro interno do servidor. Tente novamente em instantes.",
  [HttpStatus.SERVICE_UNAVAILABLE]: "Serviço temporariamente indisponível. Tente novamente em instantes.",
};

const FALLBACK_MESSAGE = "Não foi possível concluir a requisição.";

/**
 * pt-BR wording for the exceptions Nest and its middleware raise on their own: the JWT guard's
 * "Unauthorized", an unmatched route's "Cannot GET /x", multer's "File too large", and the
 * like. `DomainExceptionFilter` covers every error this codebase throws itself; this covers the
 * rest, so no English default reaches a screen that renders `message` verbatim.
 *
 * An array `message` is kept as-is: that is `ZodValidationPipe`'s per-field issue list, already
 * pt-BR via `@crop/shared`'s error map, and the web client reads its `path`s.
 */
@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    if (host.getType() !== "http") throw exception;
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception.getStatus();
    const body = exception.getResponse();
    const raw = typeof body === "object" && body !== null ? (body as { message?: unknown }).message : body;
    const message = Array.isArray(raw) ? raw : (MESSAGE_BY_STATUS[status as HttpStatus] ?? FALLBACK_MESSAGE);
    response.status(status).json({ statusCode: status, message });
  }
}
