import { QueueStatus } from "@crop/shared";
import { ConflictError } from "../../../shared/domain/errors.js";

export interface QueueEntryProps {
  id: string;
  equipmentId: string;
  patientFirstName: string;
  position: number;
  status: QueueStatus;
  scheduledAt: Date | null;
}

const VALID_TRANSITIONS: Record<QueueStatus, QueueStatus[]> = {
  [QueueStatus.WAITING]: [QueueStatus.IN_PROGRESS, QueueStatus.CANCELLED],
  [QueueStatus.IN_PROGRESS]: [QueueStatus.DONE, QueueStatus.CANCELLED],
  [QueueStatus.DONE]: [],
  [QueueStatus.CANCELLED]: [],
};

export class QueueEntry {
  constructor(private readonly props: QueueEntryProps) {}

  get id(): string {
    return this.props.id;
  }

  get equipmentId(): string {
    return this.props.equipmentId;
  }

  get status(): QueueStatus {
    return this.props.status;
  }

  get patientFirstName(): string {
    return this.props.patientFirstName;
  }

  get position(): number {
    return this.props.position;
  }

  get scheduledAt(): Date | null {
    return this.props.scheduledAt;
  }

  /** A patient can't go from DONE/CANCELLED back to WAITING, or skip straight to DONE. */
  assertCanTransitionTo(next: QueueStatus): void {
    if (!VALID_TRANSITIONS[this.props.status].includes(next)) {
      throw new ConflictError(`Cannot move queue entry from ${this.props.status} to ${next}`);
    }
  }
}
