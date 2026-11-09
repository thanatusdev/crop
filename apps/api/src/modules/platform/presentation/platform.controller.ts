import { Controller, Get, UseGuards } from "@nestjs/common";
import { QueryBus } from "@nestjs/cqrs";
import { UserRole, type PlatformStatsDto } from "@crop/shared";
import { JwtAuthGuard } from "../../iam/presentation/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../iam/presentation/guards/roles.guard.js";
import { Roles } from "../../iam/presentation/decorators/roles.decorator.js";
import { GetPlatformStatsQuery } from "../application/queries/get-platform-stats/get-platform-stats.query.js";

/** Cross-tenant overview for the PLATFORM_ADMIN dashboard -- no tenant scoping, by design. */
@Controller("platform")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.PLATFORM_ADMIN)
export class PlatformController {
  constructor(private readonly queryBus: QueryBus) {}

  @Get("stats")
  stats(): Promise<PlatformStatsDto> {
    return this.queryBus.execute(new GetPlatformStatsQuery());
  }
}
