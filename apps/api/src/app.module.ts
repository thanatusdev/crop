import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { CqrsModule } from "@nestjs/cqrs";
import { ScheduleModule } from "@nestjs/schedule";

import { validateEnv } from "./shared/infrastructure/config/env.validation.js";
import { PrismaModule } from "./shared/infrastructure/prisma/prisma.module.js";
import { RedisModule } from "./shared/infrastructure/redis/redis.module.js";
import { MetricsModule } from "./shared/infrastructure/metrics/metrics.module.js";
import { DomainExceptionFilter } from "./shared/infrastructure/http/domain-exception.filter.js";
import { RequestIdMiddleware } from "./shared/infrastructure/logging/request-id.middleware.js";

import { IamModule } from "./modules/iam/iam.module.js";
import { EquipmentModule } from "./modules/equipment/equipment.module.js";
import { SessionsModule } from "./modules/sessions/sessions.module.js";
import { AuditModule } from "./modules/audit/audit.module.js";
import { QueueModule } from "./modules/queue/queue.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // forRoot() (not the bare class) marks CQRS global and triggers the one-time discovery
    // of every @CommandHandler/@QueryHandler across the app on bootstrap.
    CqrsModule.forRoot(),
    // Required for PiKvmHealthPoller's @Cron to actually run -- @nestjs/schedule's decorator
    // discovery only happens if ScheduleModule.forRoot() is imported somewhere in the app.
    // Its absence was a real bug caught while verifying this phase: equipment status was
    // silently never updated by the poller, always showing whatever it was created with.
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    MetricsModule,
    IamModule,
    EquipmentModule,
    AuditModule,
    SessionsModule,
    QueueModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: DomainExceptionFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes("*");
  }
}
