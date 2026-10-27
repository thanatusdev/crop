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
export interface ControlSuspension {
  /** The operating company whose agreement stopped covering this session's equipment. */
  outsideTenantId: string;
  /** Its users taking part in the session -- none of them may hold control from now on. */
  userIds: readonly string[];
  /** pt-BR, for anyone (re)joining the session. */
  message: string;
}

export interface SessionRuntimePort {
  setController(sessionId: string, userId: string): void;
  /** `undefined` when nobody may send input -- including when the controller is suspended. */
  getController(sessionId: string): string | undefined;
  clear(sessionId: string): void;

  /**
   * Bars an outside company's users from controlling a live session, without ending it: see
   * `SuspendOutsideControlHandler`. Enforced inside `getController` itself, so every input path
   * (gateway, HID and print handlers) refuses them with no change of its own. Merges with any
   * earlier suspension for the same session.
   */
  suspendControl(sessionId: string, suspension: ControlSuspension): void;
  getSuspension(sessionId: string): ControlSuspension | undefined;

  /** Called on every accepted input/print event -- the dead-man's-switch clock. */
  recordActivity(sessionId: string): void;
  /** `undefined` means "never recorded" (e.g. a session that started but received no input yet). */
  getLastActivityAt(sessionId: string): number | undefined;
}
