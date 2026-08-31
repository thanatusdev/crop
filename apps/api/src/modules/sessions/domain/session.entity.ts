import { SessionStatus } from "@crop/shared";
import { ForbiddenError } from "../../../shared/domain/errors.js";

export interface SessionProps {
  id: string;
  tenantId: string;
  equipmentId: string;
  operatorId: string;
  supervisorId: string | null;
  controllerUserId: string;
  status: SessionStatus;
  startedAt: Date | null;
  endedAt: Date | null;
  queueEntryId: string | null;
}

/**
 * `controllerUserId` is the field that makes takeover a real control rather than a label:
 * every HID input event is checked against it. See ProcessHidInputHandler.
 */
export class Session {
  constructor(private props: SessionProps) {}

  get id(): string {
    return this.props.id;
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get equipmentId(): string {
    return this.props.equipmentId;
  }

  get operatorId(): string {
    return this.props.operatorId;
  }

  get supervisorId(): string | null {
    return this.props.supervisorId;
  }

  get controllerUserId(): string {
    return this.props.controllerUserId;
  }

  get status(): SessionStatus {
    return this.props.status;
  }

  get startedAt(): Date | null {
    return this.props.startedAt;
  }

  get endedAt(): Date | null {
    return this.props.endedAt;
  }

  /** The patient-queue entry this session was started against, if any -- see
   * StartSessionHandler/EndSessionHandler/AbortIdleSessionHandler, which use this to keep
   * the queue entry's own status in sync with the session's lifecycle. */
  get queueEntryId(): string | null {
    return this.props.queueEntryId;
  }

  isActive(): boolean {
    return this.props.status === SessionStatus.ACTIVE;
  }

  isController(userId: string): boolean {
    return this.props.controllerUserId === userId;
  }

  isParticipant(userId: string): boolean {
    return this.props.operatorId === userId || this.props.supervisorId === userId;
  }

  /** Only an active session can change hands, and never to whoever already holds it. */
  assertCanBeTakenOverBy(supervisorId: string): void {
    if (!this.isActive()) {
      throw new ForbiddenError("Cannot take over a session that is not active");
    }
    if (this.props.controllerUserId === supervisorId) {
      throw new ForbiddenError("This user is already in control of the session");
    }
  }

  /**
   * The mirror of `assertCanBeTakenOverBy`: control can only be handed *back* if someone
   * other than the operator currently holds it. Deliberately takes no `actingUserId` --
   * unlike takeover, the acting supervisor/admin isn't becoming the controller themselves,
   * so there's no "already the controller" case to check for them specifically. See
   * ReturnControlToOperatorHandler for why only elevated roles may call this at all: the
   * operator never gets to unilaterally reclaim control just by asking.
   */
  assertControlCanBeReturnedToOperator(): void {
    if (!this.isActive()) {
      throw new ForbiddenError("Cannot change control on a session that is not active");
    }
    if (this.props.controllerUserId === this.props.operatorId) {
      throw new ForbiddenError("The operator is already in control of this session");
    }
  }
}
