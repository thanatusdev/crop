import { QueueDocumentKind } from "@crop/shared";

export interface QueueEntryDocumentProps {
  id: string;
  queueEntryId: string;
  /// Derived through `queueEntry.equipment.tenantId` at read time, never stored redundantly
  /// -- the same choice `QueueEntry`/`ExamMessage` already made for their own `tenantId`.
  tenantId: string;
  /// Also derived through the same relation -- needed by `OperatorAccessService
  /// .assertCanReachEquipmentId`, which the download route (but not upload/remove) checks.
  equipmentId: string;
  kind: QueueDocumentKind;
  path: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedByUserId: string;
  uploadedAt: Date;
}

/**
 * A physician's order or prior report the nurse uploaded against one `QueueEntry` -- see
 * `schema.prisma`'s own docstring on the `QueueEntryDocument` model for why this is a child
 * table rather than a nullable column group like `ExamMessage`'s single attachment.
 *
 * Deliberately its own small entity, not a prop bag folded into `QueueEntry` itself: the
 * document list is read, written, and authorized independently of the exam-detail form (see
 * `QueueController`'s own routes), the same separation `ExamMessage` already keeps from
 * `QueueEntry` despite the identical FK relationship.
 */
export class QueueEntryDocument {
  constructor(private readonly props: QueueEntryDocumentProps) {}

  get id(): string {
    return this.props.id;
  }

  get queueEntryId(): string {
    return this.props.queueEntryId;
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get equipmentId(): string {
    return this.props.equipmentId;
  }

  get kind(): QueueDocumentKind {
    return this.props.kind;
  }

  get path(): string {
    return this.props.path;
  }

  get filename(): string {
    return this.props.filename;
  }

  get mimeType(): string {
    return this.props.mimeType;
  }

  get sizeBytes(): number {
    return this.props.sizeBytes;
  }

  get uploadedByUserId(): string {
    return this.props.uploadedByUserId;
  }

  get uploadedAt(): Date {
    return this.props.uploadedAt;
  }

  /** Multi-tenant isolation -- same role as `QueueEntry.belongsToTenant`. */
  belongsToTenant(tenantId: string): boolean {
    return this.props.tenantId === tenantId;
  }
}
