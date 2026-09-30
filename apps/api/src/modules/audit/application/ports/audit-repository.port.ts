import type { AuditEvent } from "../../domain/audit-event.js";
import type { AuditLogEntryDto } from "@crop/shared";
import type { HashChainInput } from "@crop/shared";

export const AUDIT_REPOSITORY = Symbol("AUDIT_REPOSITORY");

export interface ListAuditLogsFilter {
  tenantId: string;
  sessionId?: string;
  userId?: string;
  /** Added for `GetQueueEntryTimelineQuery` -- narrows to one resource's own rows (e.g.
   * `resourceType: "QueueEntry"` + a specific entry's id). Both undefined preserves the
   * pre-existing unscoped-by-resource behaviour every `AuditController` caller still uses. */
  resourceType?: string;
  resourceId?: string;
  limit: number;
  offset: number;
}

export interface ChainRow {
  input: HashChainInput;
  hash: string;
}

export interface AuditRepositoryPort {
  /** Synchronous, critical-path write. Computes and stores this row's hash under a per-tenant lock. */
  appendCritical(event: AuditEvent): Promise<void>;
  /** Batch write for the audit-flush cron: one transaction, hashes chained within the batch. */
  appendBatch(tenantId: string, events: AuditEvent[]): Promise<void>;
  list(filter: ListAuditLogsFilter): Promise<AuditLogEntryDto[]>;
  loadChain(tenantId: string): Promise<ChainRow[]>;
}
