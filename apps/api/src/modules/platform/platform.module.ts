import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";

import { PlatformController } from "./presentation/platform.controller.js";
import { PLATFORM_STATS_REPOSITORY } from "./application/ports/platform-stats-repository.port.js";
import { PrismaPlatformStatsRepository } from "./infrastructure/prisma-platform-stats.repository.js";
import { GetPlatformStatsHandler } from "./application/queries/get-platform-stats/get-platform-stats.handler.js";
import { AuditModule } from "../audit/audit.module.js";
import { IamModule } from "../iam/iam.module.js";

@Module({
  // IamModule for JwtAuthGuard's token verification, AuditModule for RolesGuard's denial audit.
  imports: [CqrsModule, IamModule, AuditModule],
  controllers: [PlatformController],
  providers: [{ provide: PLATFORM_STATS_REPOSITORY, useClass: PrismaPlatformStatsRepository }, GetPlatformStatsHandler],
})
export class PlatformModule {}
