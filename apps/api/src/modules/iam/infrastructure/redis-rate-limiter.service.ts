import { Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";
import { REDIS_CLIENT } from "../../../shared/infrastructure/redis/redis.tokens.js";
import type { RateLimitCheck, RateLimiterPort } from "../application/ports/rate-limiter.port.js";

// INCR-then-conditionally-EXPIRE must be atomic, or two concurrent requests against a fresh
// key could both see count==1 and both set an EXPIRE, or worse, a request could land between
// the INCR and the EXPIRE and never get a TTL set at all (a key that never expires is a
// silent, permanent lockout once one is ever hit) -- a Lua script run by Redis is a single
// atomic operation, whereas a MULTI/EXEC of the same two commands is not: MULTI queues
// commands without evaluating their results, so "EXPIRE only if this was the first INCR"
// cannot be expressed with MULTI/EXEC at all.
const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

@Injectable()
export class RedisRateLimiterService implements RateLimiterPort {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async checkAndIncrement(key: string, maxAttempts: number, windowSeconds: number): Promise<RateLimitCheck> {
    const count = (await this.redis.eval(INCREMENT_SCRIPT, 1, key, windowSeconds)) as number;
    return { allowed: count <= maxAttempts, remaining: Math.max(0, maxAttempts - count) };
  }
}
