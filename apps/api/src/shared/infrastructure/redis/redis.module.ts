import { Global, Module } from "@nestjs/common";
import { REDIS_CLIENT } from "./redis.tokens.js";
import { RedisConnectionService } from "./redis-connection.service.js";

@Global()
@Module({
  providers: [
    RedisConnectionService,
    {
      provide: REDIS_CLIENT,
      inject: [RedisConnectionService],
      useFactory: (connection: RedisConnectionService) => connection.client,
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
