import { z } from "zod";

const Count = z.number().int().nonnegative();

/**
 * Platform-wide totals for the PLATFORM_ADMIN dashboard (`GET /platform/stats`). Computed
 * server-side because every other listing endpoint is tenant-scoped -- a platform admin has no
 * client-side way to count another tenant's users, equipment or sessions. Tenants and
 * equipment are split by `deactivatedAt` (soft deactivation, never deletion); users report
 * how many logged in within the last 30 days as a rough measure of real usage.
 */
export const PlatformStatsSchema = z.object({
  users: z.object({ total: Count, activeLast30Days: Count }),
  clinics: z.object({ active: Count, deactivated: Count }),
  operators: z.object({ active: Count, deactivated: Count }),
  equipment: z.object({ total: Count, online: Count }),
  sessions: z.object({ active: Count }),
  agreements: z.object({ active: Count, pending: Count }),
});
export type PlatformStatsDto = z.infer<typeof PlatformStatsSchema>;
