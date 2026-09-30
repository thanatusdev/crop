import { ConflictError } from "../../../shared/domain/errors.js";

export interface MessageShortcutProps {
  id: string;
  tenantId: string;
  code: string;
  label: string;
  body: string;
  createdByUserId: string | null;
  deactivatedAt: Date | null;
  createdAt: Date;
}

/** A canned quick-reply -- see `MessageShortcutSchema`'s own docstring in packages/shared
 * for why this is scoped per-clinic rather than per-operator-company. Unlike `ExamMessage`,
 * this model owns a real `tenantId` column (see schema.prisma): a shortcut exists
 * independently of any equipment, so there is no relation to derive one through. */
export class MessageShortcut {
  constructor(private readonly props: MessageShortcutProps) {}

  get id(): string {
    return this.props.id;
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get code(): string {
    return this.props.code;
  }

  get label(): string {
    return this.props.label;
  }

  get body(): string {
    return this.props.body;
  }

  get createdByUserId(): string | null {
    return this.props.createdByUserId;
  }

  get deactivatedAt(): Date | null {
    return this.props.deactivatedAt;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  belongsToTenant(tenantId: string): boolean {
    return this.props.tenantId === tenantId;
  }

  isActive(): boolean {
    return this.props.deactivatedAt === null;
  }

  /** `code` is unique per clinic (see the model's own `@@unique`) -- surfaced here as a
   * named domain check rather than only a database constraint violation, so
   * `CreateMessageShortcutHandler` can report a clear, expected conflict instead of letting a
   * raw Postgres unique-violation error leak through. */
  static assertCodeAvailable(existing: MessageShortcut | null, code: string): void {
    if (existing) {
      throw new ConflictError(`A shortcut with code "${code}" already exists for this clinic`);
    }
  }
}
