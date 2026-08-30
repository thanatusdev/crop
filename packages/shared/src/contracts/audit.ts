import { z } from "zod";

export const AuditLogEntrySchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  tenantId: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  sessionId: z.string().uuid().nullable(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  details: z.unknown(),
  hash: z.string(),
  prevHash: z.string().nullable(),
  timestamp: z.string(),
});
export type AuditLogEntryDto = z.infer<typeof AuditLogEntrySchema>;

export const VerifyChainResultSchema = z.object({
  valid: z.boolean(),
  checkedRows: z.number().int(),
  brokenAtSeq: z.number().int().nullable(),
});
export type VerifyChainResultDto = z.infer<typeof VerifyChainResultSchema>;
