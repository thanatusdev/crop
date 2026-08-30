import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { requestContext } from "./request-context.js";

const HEADER = "x-request-id";

/**
 * One correlation id per request, for tracing a single operation across every log line it
 * produces (a session start, its audit write, its equipment lookup, all correlated). Trusts
 * an inbound `X-Request-Id` if present (e.g. from a reverse proxy or load balancer that
 * already assigned one) rather than always minting a fresh one, so a request's id stays
 * consistent across hops in front of this service.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = (req.headers[HEADER] as string | undefined) ?? randomUUID();
    res.setHeader("X-Request-Id", requestId);
    requestContext.run({ requestId }, next);
  }
}
