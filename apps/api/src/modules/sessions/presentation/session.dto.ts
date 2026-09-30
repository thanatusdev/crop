import type { SessionState } from "@crop/shared";
import { Session } from "../domain/session.entity.js";
import type { OperatorProfile } from "../application/session-participant-name.service.js";

/** `operator` (name + registration) is resolved by the caller (`SessionParticipantNameService`)
 * rather than looked up in here -- this stays a pure, synchronous mapper, and every call site
 * already has to reach into IAM through the CQRS bus/DI graph differently (controller vs
 * gateway), so there is no single natural place inside this function to do that lookup
 * itself. */
export function toSessionDto(session: Session, operator: OperatorProfile): SessionState {
  return {
    id: session.id,
    equipmentId: session.equipmentId,
    operatorId: session.operatorId,
    operatorName: operator.name,
    operatorRegistration: operator.registration,
    supervisorId: session.supervisorId,
    controllerUserId: session.controllerUserId,
    status: session.status,
    startedAt: session.startedAt?.toISOString() ?? null,
    endedAt: session.endedAt?.toISOString() ?? null,
    queueEntryId: session.queueEntryId,
  };
}
