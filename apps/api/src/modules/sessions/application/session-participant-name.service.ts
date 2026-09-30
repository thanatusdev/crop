import { Inject, Injectable } from "@nestjs/common";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../iam/application/ports/user-repository.port.js";
import { Session } from "../domain/session.entity.js";

/** Name + professional registration together -- what `SessionState.operatorName`/
 * `operatorRegistration` and the nursing screen's "Operador Remoto" card both need out of
 * one lookup. */
export interface OperatorProfile {
  name: string | null;
  registration: string | null;
}

/**
 * Resolves the display name (and, for operators, professional registration) behind a bare
 * user id, for the places a `Session`-shaped payload needs one: `SessionState.operatorName`/
 * `operatorRegistration` (the nursing lock banner and "Operador Remoto" card) and
 * `ControllerChangedEvent.controllerName` (which used to hold a raw UUID, not a name -- see
 * that field's own docstring in packages/shared/src/contracts/session.ts). Batched even for
 * a single session (`resolveOperatorProfile` delegates to `resolveOperatorProfiles`) so
 * there is only one code path to keep correct, mirroring `UnitEnrichmentService`.
 */
@Injectable()
export class SessionParticipantNameService {
  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort) {}

  async resolveOperatorProfiles(sessions: Session[]): Promise<Map<string, OperatorProfile>> {
    const uniqueIds = [...new Set(sessions.map((session) => session.operatorId))];
    if (uniqueIds.length === 0) return new Map();
    const profiles = await this.users.summarizeProfiles(uniqueIds);
    return new Map(
      uniqueIds.map((id) => [id, { name: profiles[id]?.name ?? null, registration: profiles[id]?.professionalRegistration ?? null }])
    );
  }

  async resolveOperatorProfile(session: Session): Promise<OperatorProfile> {
    const profiles = await this.resolveOperatorProfiles([session]);
    return profiles.get(session.operatorId) ?? { name: null, registration: null };
  }

  /** For `ControllerChangedEvent.controllerName` -- the controller is whoever currently
   * holds HID input, which after a takeover is the supervisor/admin rather than the
   * operator, so this takes a bare user id rather than a `Session`. No registration number:
   * nothing renders one for a controller today. */
  async resolveUserName(userId: string): Promise<string | null> {
    const names = await this.users.summarizeDisplayNames([userId]);
    return names[userId] ?? null;
  }
}
