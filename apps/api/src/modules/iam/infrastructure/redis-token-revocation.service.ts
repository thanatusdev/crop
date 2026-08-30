import { Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";
import { REDIS_CLIENT } from "../../../shared/infrastructure/redis/redis.tokens.js";
import type { TokenRevocationPort } from "../application/ports/token-revocation.port.js";

function key(jti: string): string {
  return `revoked:refresh:${jti}`;
}

@Injectable()
export class RedisTokenRevocationService implements TokenRevocationPort {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async revoke(jti: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return; // already expired by the time logout ran -- nothing to revoke
    await this.redis.set(key(jti), "1", "EX", ttlSeconds);
  }

  async isRevoked(jti: string): Promise<boolean> {
    return (await this.redis.exists(key(jti))) === 1;
  }
}
