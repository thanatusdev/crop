import { Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";
import { REDIS_CLIENT } from "../../../shared/infrastructure/redis/redis.tokens.js";
import type { AuditBufferPort, BufferedInputItem } from "../application/ports/audit-buffer.port.js";

const KEY_PREFIX = "audit:buffer:";
const INDEX_KEY = "audit:buffer:index"; // Set of session ids that currently have buffered items

function bufferKey(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

@Injectable()
export class RedisAuditBufferAdapter implements AuditBufferPort {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async push(sessionId: string, item: BufferedInputItem): Promise<void> {
    await this.redis.multi().rpush(bufferKey(sessionId), JSON.stringify(item)).sadd(INDEX_KEY, sessionId).exec();
  }

  async claimAndClear(sessionId: string): Promise<BufferedInputItem[]> {
    const key = bufferKey(sessionId);
    const claimKey = `${key}:claim:${Date.now()}`;

    // RENAME is atomic: any RPUSH that arrives after this line lands on a freshly-created
    // `key`, never on the batch we're about to read and delete, so nothing pushed concurrently
    // is ever lost. If the source key doesn't exist (nothing buffered), ioredis rejects --
    // treated the same as "nothing to claim".
    const renamed = await this.redis.renamenx(key, claimKey).catch(() => 0);
    if (!renamed) {
      await this.redis.srem(INDEX_KEY, sessionId);
      return [];
    }

    const raw = await this.redis.lrange(claimKey, 0, -1);
    await this.redis.multi().del(claimKey).srem(INDEX_KEY, sessionId).exec();

    return raw.map((json) => JSON.parse(json) as BufferedInputItem);
  }

  async listBufferedSessionIds(): Promise<string[]> {
    return this.redis.smembers(INDEX_KEY);
  }
}
