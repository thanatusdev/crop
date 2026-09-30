export interface ExamMessageAttachmentProps {
  path: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ExamMessageProps {
  id: string;
  tenantId: string;
  equipmentId: string;
  queueEntryId: string | null;
  authorUserId: string;
  body: string;
  attachment: ExamMessageAttachmentProps | null;
  createdAt: Date;
}

/**
 * One message in the exam-support chat -- see `ExamMessageSchema`'s own docstring in
 * packages/shared for why this is tied to the equipment rather than to any one session.
 *
 * `tenantId` is not a real column (see schema.prisma's own comment on the model): like
 * `QueueEntry`, it is derived through the `equipment` relation at read time, never stored
 * redundantly, so there is exactly one place ("what tenant does this equipment belong to")
 * that can ever answer the question.
 */
export class ExamMessage {
  constructor(private readonly props: ExamMessageProps) {}

  get id(): string {
    return this.props.id;
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get equipmentId(): string {
    return this.props.equipmentId;
  }

  get queueEntryId(): string | null {
    return this.props.queueEntryId;
  }

  get authorUserId(): string {
    return this.props.authorUserId;
  }

  get body(): string {
    return this.props.body;
  }

  get attachment(): ExamMessageAttachmentProps | null {
    return this.props.attachment;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  belongsToTenant(tenantId: string): boolean {
    return this.props.tenantId === tenantId;
  }
}
