import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

/**
 * A thin class wrapper around the ioredis client purely so Nest's lifecycle hooks can close
 * the connection on shutdown. A plain `useFactory` returning a bare `Redis` instance (the
 * previous version of this file) has no lifecycle hook to attach to, which leaves the TCP
 * connection open on `app.close()` -- harmless for a long-running server that's killed by
 * the OS anyway, but it hangs any one-shot script (e.g. infra/seeds/seed.ts) that awaits a
 * graceful shutdown before exiting.
 */
@Injectable()
export class RedisConnectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisConnectionService.name);
  readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis(config.getOrThrow<string>("REDIS_URL"), {
      // AOF fsync policy is set on the Redis server itself (see docker-compose.yml); this
      // client just needs sane retry behaviour for a service that must survive brief Redis
      // restarts without operators noticing.
      maxRetriesPerRequest: 3,
    });
  }

  onModuleInit(): void {
    this.logger.log("Connected to Redis");
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
