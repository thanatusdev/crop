import type { HidInputEvent } from "@crop/shared";

export const AUDIT_BUFFER = Symbol("AUDIT_BUFFER");

export interface BufferedInputItem {
  tenantId: string;
  userId: string;
  event: HidInputEvent;
}

/**
 * High-frequency HID events (up to 60/s per session) never hit Postgres directly -- see
 * docs/architecture.md's two-tier audit design. This is the Redis-backed staging area the
 * cron in FlushAuditBufferHandler drains every AUDIT_FLUSH_INTERVAL_MS.
 */
export interface AuditBufferPort {
  push(sessionId: string, item: BufferedInputItem): Promise<void>;
  /** Atomically takes everything currently buffered for a session and empties the buffer. */
  claimAndClear(sessionId: string): Promise<BufferedInputItem[]>;
  /** Every session id that currently has at least one buffered event, for the cron to sweep. */
  listBufferedSessionIds(): Promise<string[]>;
}
