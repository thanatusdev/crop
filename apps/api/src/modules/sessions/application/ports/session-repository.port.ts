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
  setController(sessionId: string, controllerUserId: string, supervisorId: string): Promise<void>;
  end(sessionId: string, status: "ENDED" | "ABORTED"): Promise<void>;
}
