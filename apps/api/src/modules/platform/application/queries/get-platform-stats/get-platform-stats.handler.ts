import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import type { PlatformStatsDto } from "@crop/shared";
import { PLATFORM_STATS_REPOSITORY, type PlatformStatsRepositoryPort } from "../../ports/platform-stats-repository.port.js";
import { GetPlatformStatsQuery } from "./get-platform-stats.query.js";

@QueryHandler(GetPlatformStatsQuery)
export class GetPlatformStatsHandler implements IQueryHandler<GetPlatformStatsQuery, PlatformStatsDto> {
  constructor(@Inject(PLATFORM_STATS_REPOSITORY) private readonly stats: PlatformStatsRepositoryPort) {}

  execute(query: GetPlatformStatsQuery): Promise<PlatformStatsDto> {
    return this.stats.getStats(query.now);
  }
}
