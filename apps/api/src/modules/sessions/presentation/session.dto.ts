import type { SessionState } from "@crop/shared";
import { Session } from "../domain/session.entity.js";

export function toSessionDto(session: Session): SessionState {
  return {
    id: session.id,
    equipmentId: session.equipmentId,
    operatorId: session.operatorId,
    supervisorId: session.supervisorId,
    controllerUserId: session.controllerUserId,
    status: session.status,
    startedAt: session.startedAt?.toISOString() ?? null,
    endedAt: session.endedAt?.toISOString() ?? null,
  };
}
