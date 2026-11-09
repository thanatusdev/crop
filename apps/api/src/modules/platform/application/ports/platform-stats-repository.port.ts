import type { PlatformStatsDto } from "@crop/shared";

export const PLATFORM_STATS_REPOSITORY = Symbol("PLATFORM_STATS_REPOSITORY");

/**
 * Read-only, cross-tenant aggregates. Counts every module's tables straight through Prisma
 * rather than through each module's own port -- the same shortcut `PrismaTenantRepository`'s
 * summaries take, and for the same reason: importing every module here would only add
 * cycles for what are plain `count()` queries.
 */
export interface PlatformStatsRepositoryPort {
  /** `now` anchors the "active in the last 30 days" window, so tests can pin it. */
  getStats(now: Date): Promise<PlatformStatsDto>;
}
