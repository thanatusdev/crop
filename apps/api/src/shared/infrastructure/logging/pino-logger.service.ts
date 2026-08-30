import { Injectable, type LoggerService } from "@nestjs/common";
import { pino, type Logger as Pino } from "pino";
import { requestContext } from "./request-context.js";

/**
 * Structured JSON logs (one line per event, machine-parseable) with the current request's
 * correlation id attached automatically -- see request-context.ts. Registered once via
 * `app.useLogger(...)` in main.ts, which redirects every `new Logger(SomeContext)` already
 * used throughout the codebase (PiKvmConnectionRegistry, AuditFlushScheduler, etc.) through
 * this implementation without any of those call sites needing to change.
 *
 * Mirrors Nest's own `ConsoleLogger` calling convention: the last argument is the `context`
 * string (the class name passed to `new Logger(context)`) if it happens to be a string;
 * anything else trailing is captured as extra structured fields rather than dropped.
 */
@Injectable()
export class PinoLoggerService implements LoggerService {
  private readonly logger: Pino;

  constructor() {
    this.logger = pino({
      level: process.env.LOG_LEVEL ?? "info",
      // Pretty-printing is a dev-only convenience; production expects plain JSON lines for
      // log aggregation (CloudWatch, Loki, whatever), not a formatting library in the path.
      transport:
        process.env.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" } }
          : undefined,
    });
  }

  log(message: unknown, ...params: unknown[]): void {
    this.write("info", message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write("error", message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write("warn", message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write("debug", message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write("trace", message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write("fatal", message, params);
  }

  private write(level: "info" | "error" | "warn" | "debug" | "trace" | "fatal", message: unknown, params: unknown[]): void {
    const rest = [...params];
    const context = typeof rest[rest.length - 1] === "string" ? (rest.pop() as string) : undefined;

    const fields: Record<string, unknown> = { context, requestId: requestContext.getRequestId() };
    if (rest.length > 0) fields.extra = rest;

    this.logger[level](fields, typeof message === "string" ? message : JSON.stringify(message));
  }
}
