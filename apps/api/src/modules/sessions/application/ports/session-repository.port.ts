import { Session } from "../../domain/session.entity.js";

export const SESSION_REPOSITORY = Symbol("SESSION_REPOSITORY");

export interface CreateSessionData {
  equipmentId: string;
  operatorId: string;
  queueEntryId: string | null;
}

export interface SessionRepositoryPort {
  create(data: CreateSessionData): Promise<Session>;
  findById(id: string): Promise<Session | null>;
  /** The equipment's current active/pending session, if any -- see StartSessionHandler,
   * which uses this to refuse a second concurrent session on equipment already in use. */
  findActiveByEquipment(equipmentId: string): Promise<Session | null>;
  /** Active + pending sessions for a tenant, joined through equipment. Powers the dashboard. */
  listActiveByTenant(tenantId: string): Promise<Session[]>;
  /** Every active session regardless of tenant -- used only by cross-tenant system crons
   * (snapshot capture, idle-timeout sweep), matching EquipmentRepositoryPort.listAll(). */
  listAllActive(): Promise<Session[]>;
  countActiveByOperator(operatorId: string): Promise<number>;
  /**
   * Compare-and-swap, not an unconditional write: only applies if the row's current
   * `controllerUserId` still matches `expectedCurrentControllerUserId` at the moment of the
   * update. Returns whether it actually applied. This is what makes two near-simultaneous
   * takeover attempts safe -- without it, both could read the same stale controller, both
   * pass the domain check, and both write, leaving whichever transaction commits last as the
   * "real" controller while the other believes it won too (and, worse, the in-memory
   * `SessionRuntimePort` -- the actual authority for gating live input, see its own
   * docstring -- could end up disagreeing with whatever the database ends up holding). See
   * ExecuteTakeoverHandler.
   */
  setController(
    sessionId: string,
    controllerUserId: string,
    supervisorId: string | null,
    expectedCurrentControllerUserId: string
  ): Promise<boolean>;
  end(sessionId: string, status: "ENDED" | "ABORTED"): Promise<void>;
}
