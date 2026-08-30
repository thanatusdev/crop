export const SESSION_RUNTIME = Symbol("SESSION_RUNTIME");

/**
 * The authoritative, low-latency answer to "whose input is accepted right now" for an
 * active session. Backed by an in-process Map, not Redis or Postgres: at 60 input events per
 * second per session, a network round trip on every single event would burn a meaningful
 * slice of the sub-200ms budget for a value that only ever changes on takeover (a rare,
 * already-latency-tolerant operation).
 *
 * This is a deliberate MVP scope decision, not an oversight: it requires the gateway to run
 * as a single process per PiKVM device (documented in docs/architecture.md). Horizontally
 * scaling this later means moving this cache to Redis with pub/sub invalidation -- the port
 * boundary here is exactly where that change would be made, without touching any handler.
 */
export interface SessionRuntimePort {
  setController(sessionId: string, userId: string): void;
  getController(sessionId: string): string | undefined;
  clear(sessionId: string): void;

  /** Called on every accepted input/print event -- the dead-man's-switch clock. */
  recordActivity(sessionId: string): void;
  /** `undefined` means "never recorded" (e.g. a session that started but received no input yet). */
  getLastActivityAt(sessionId: string): number | undefined;
}
