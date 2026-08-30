import { UserRole } from "@crop/shared";

export interface UserProps {
  id: string;
  tenantId: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  mfaSecret: string | null;
  mfaEnabledAt: Date | null;
  lastLoginAt: Date | null;
  lockedAt: Date | null;
}

/**
 * A thin domain wrapper around the persisted user row. It exists to hold the invariants that
 * matter for authorization decisions (is MFA enrolled? which tenant?) as named, testable
 * predicates instead of scattering `user.mfaEnabledAt !== null` checks across handlers.
 */
export class User {
  constructor(private readonly props: UserProps) {}

  get id(): string {
    return this.props.id;
  }

  get tenantId(): string {
    return this.props.tenantId;
  }

  get email(): string {
    return this.props.email;
  }

  get role(): UserRole {
    return this.props.role;
  }

  get passwordHash(): string {
    return this.props.passwordHash;
  }

  get mfaSecret(): string | null {
    return this.props.mfaSecret;
  }

  isMfaEnrolled(): boolean {
    return this.props.mfaEnabledAt !== null && this.props.mfaSecret !== null;
  }

  // Nullable timestamp, not a boolean column: `lockedAt` doubles as a "when" for anyone
  // reviewing why an account can't log in, at no extra cost over a plain flag.
  isLocked(): boolean {
    return this.props.lockedAt !== null;
  }

  hasAnyRole(...roles: UserRole[]): boolean {
    return roles.includes(this.props.role);
  }

  belongsToTenant(tenantId: string): boolean {
    return this.props.tenantId === tenantId;
  }
}
