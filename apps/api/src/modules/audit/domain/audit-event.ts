import { AuditAction } from "@crop/shared";

/**
 * The domain concept here is narrow on purpose: audit *records* have almost no business
 * rules of their own beyond "must be hash-chained and immutable", both of which are enforced
 * elsewhere (the hash chain in @crop/shared, immutability by a Postgres migration). This
 * type exists so commands and the repository agree on a single shape for "a fact to record"
 * without every call site repeating seven positional constructor arguments.
 */
export interface AuditEvent {
  tenantId: string;
  userId: string | null;
  sessionId: string | null;
  action: AuditAction;
  resourceType: string;
  resourceId: string | null;
  details: unknown;
  ip?: string | null;
  userAgent?: string | null;
}
