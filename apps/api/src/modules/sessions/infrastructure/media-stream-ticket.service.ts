import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { UnauthorizedError } from "../../../shared/domain/errors.js";

export interface MediaStreamTicketClaims {
  sub: string; // userId
  tenantId: string;
  sessionId: string;
}

/**
 * Browsers cannot set custom headers on a WebSocket upgrade request, so the normal Bearer
 * access token can't authenticate the raw `/stream` connection directly. Instead the
 * frontend fetches one of these over a normal (header-authenticated) REST call and passes
 * it as a query parameter. Short TTL (default 30s) limits the blast radius if it leaks into
 * a browser history or a proxy log.
 */
@Injectable()
export class MediaStreamTicketService {
  private readonly secret: string;
  private readonly ttlSeconds: number;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService
  ) {
    this.secret = config.getOrThrow<string>("JWT_ACCESS_SECRET");
    this.ttlSeconds = config.get<number>("MEDIA_STREAM_TICKET_TTL_SECONDS", 30);
  }

  issue(userId: string, tenantId: string, sessionId: string): string {
    const claims: MediaStreamTicketClaims = { sub: userId, tenantId, sessionId };
    return this.jwt.sign(claims, { secret: this.secret, expiresIn: this.ttlSeconds });
  }

  verify(ticket: string): MediaStreamTicketClaims {
    try {
      return this.jwt.verify<MediaStreamTicketClaims>(ticket, { secret: this.secret });
    } catch {
      throw new UnauthorizedError("Invalid or expired media stream ticket");
    }
  }
}
