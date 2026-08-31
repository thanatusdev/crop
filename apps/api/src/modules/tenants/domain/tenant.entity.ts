import { TenantType } from "@crop/shared";

export interface TenantProps {
  id: string;
  name: string;
  type: TenantType;
  createdAt: Date;
  deactivatedAt: Date | null;
}

/**
 * A thin domain wrapper around the persisted tenant row -- same shape and reasoning as
 * `User`: named, testable predicates instead of scattering `tenant.deactivatedAt !== null`
 * checks across handlers.
 */
export class Tenant {
  constructor(private readonly props: TenantProps) {}

  get id(): string {
    return this.props.id;
  }

  get name(): string {
    return this.props.name;
  }

  get type(): TenantType {
    return this.props.type;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  // Nullable timestamp, not a boolean column -- same reasoning as User.lockedAt: doubles as
  // a "when" for anyone reviewing why a tenant's users suddenly can't log in.
  isDeactivated(): boolean {
    return this.props.deactivatedAt !== null;
  }
}
