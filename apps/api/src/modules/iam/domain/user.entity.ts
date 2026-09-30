import { UserRole } from "@crop/shared";

export interface UserProps {
  id: string;
  tenantId: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  firstName: string | null;
  lastName: string | null;
  professionalRegistration: string | null;
  mfaSecret: string | null;
  mfaEnabledAt: Date | null;
  lastLoginAt: Date | null;
  lockedAt: Date | null;
  // Set on every password change now (self-service reset, forced in-band change, AND admin
  // reset -- see AdminResetPasswordHandler, which now revokes too). Distinct from
  // `passwordChangedAt`: this is a session-revocation watermark, that's a credential-age
  // clock -- see schema.prisma's own comment on why both still exist separately.
  sessionsRevokedAt: Date | null;
  // Drives the PASSWORD_MAX_AGE_DAYS expiry check (see `isPasswordExpired`).
  passwordChangedAt: Date;
  // True for a password nobody chose for themselves -- an admin-issued temp password, fresh
  // or reset. See `passwordChangeReason`.
  mustChangePassword: boolean;
  // Onboarding via invitation link (see UserRepositoryPort.create's own docstring):
  // `activatedAt === null` means the account exists but nobody has redeemed its invitation
  // yet, and cannot log in at all (see `isActivated`/LoginHandler). `invitedAt` is display
  // metadata only (when the invite was created), never itself checked for authorization.
  invitedAt: Date | null;
  activatedAt: Date | null;
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

  get firstName(): string | null {
    return this.props.firstName;
  }

  get lastName(): string | null {
    return this.props.lastName;
  }

  get professionalRegistration(): string | null {
    return this.props.professionalRegistration;
  }

  get passwordChangedAt(): Date {
    return this.props.passwordChangedAt;
  }

  get mustChangePassword(): boolean {
    return this.props.mustChangePassword;
  }

  get invitedAt(): Date | null {
    return this.props.invitedAt;
  }

  /** False for an account nobody has claimed yet via its invitation link -- see
   * `activatedAt`'s own docstring. Checked by LoginHandler, which rejects a login attempt
   * outright rather than letting it fail against the random, unusable placeholder hash
   * RegisterUserHandler set at creation. */
  isActivated(): boolean {
    return this.props.activatedAt !== null;
  }

  isMfaEnrolled(): boolean {
    return this.props.mfaEnabledAt !== null && this.props.mfaSecret !== null;
  }

  // Nullable timestamp, not a boolean column: `lockedAt` doubles as a "when" for anyone
  // reviewing why an account can't log in, at no extra cost over a plain flag.
  isLocked(): boolean {
    return this.props.lockedAt !== null;
  }

  /** True if a refresh token issued at `issuedAtSeconds` (a JWT `iat`, seconds since epoch)
   * predates this user's most recent self-service password reset, and must therefore be
   * rejected even though it isn't individually denylisted by `jti` -- see
   * RefreshTokensHandler. `sessionsRevokedAt` starting `null` means every token is valid
   * with respect to this check, forever, until the first reset ever happens. */
  issuedBeforeSessionsRevoked(issuedAtSeconds: number): boolean {
    if (!this.props.sessionsRevokedAt) return false;
    return issuedAtSeconds * 1000 < this.props.sessionsRevokedAt.getTime();
  }

  /** True once `passwordChangedAt` is more than `maxAgeDays` in the past. `maxAgeDays <= 0`
   * disables expiry entirely -- see PASSWORD_MAX_AGE_DAYS's own env.validation.ts comment. */
  isPasswordExpired(maxAgeDays: number): boolean {
    if (maxAgeDays <= 0) return false;
    const ageMs = Date.now() - this.props.passwordChangedAt.getTime();
    return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
  }

  /**
   * The single decision point VerifyMfaHandler uses to route to a `password_change_required`
   * response instead of minting a session. `mustChangePassword` (an admin-issued temp
   * password -- fresh registration or admin reset) is checked first and reported as
   * `"must_change"` even when the password would also count as expired by age: the two
   * reasons drive different copy on the frontend, and "an admin just gave you this
   * password" is the more specific, more useful one to tell the user.
   */
  passwordChangeReason(maxAgeDays: number): "must_change" | "expired" | null {
    if (this.props.mustChangePassword) return "must_change";
    if (this.isPasswordExpired(maxAgeDays)) return "expired";
    return null;
  }

  hasAnyRole(...roles: UserRole[]): boolean {
    return roles.includes(this.props.role);
  }

  belongsToTenant(tenantId: string): boolean {
    return this.props.tenantId === tenantId;
  }
}
