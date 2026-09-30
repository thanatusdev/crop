import { Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";
import { REDIS_CLIENT } from "../../../shared/infrastructure/redis/redis.tokens.js";
import type { RevocationKind, TokenRevocationPort } from "../application/ports/token-revocation.port.js";

function key(jti: string, kind: RevocationKind): string {
  const prefix = kind === "password_reset" ? "pwreset" : kind === "password_change" ? "pwchange" : kind === "account_invitation" ? "invite" : "refresh";
  return `revoked:${prefix}:${jti}`;
}

@Injectable()
export class RedisTokenRevocationService implements TokenRevocationPort {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async revoke(jti: string, ttlSeconds: number, kind: RevocationKind = "refresh"): Promise<void> {
    if (ttlSeconds <= 0) return; // already expired by the time this ran -- nothing to revoke
    await this.redis.set(key(jti, kind), "1", "EX", ttlSeconds);
  }

  async isRevoked(jti: string, kind: RevocationKind = "refresh"): Promise<boolean> {
    return (await this.redis.exists(key(jti, kind))) === 1;
  }
}
