import { User } from "../../domain/user.entity.js";

export const USER_REPOSITORY = Symbol("USER_REPOSITORY");

export interface CreateUserData {
  tenantId: string;
  email: string;
  passwordHash: string;
  role: User["role"];
  mfaSecret: string;
  firstName: string;
  lastName: string;
  professionalRegistration?: string | null;
  /** True for the HTTP admin-create path (a temp password nobody has chosen yet, see
   * `UserProps.mustChangePassword`'s own docstring); `false` for seed scripts, which
   * auto-confirm MFA on the user's behalf and are simulating an already-onboarded account,
   * not a freshly-provisioned one -- see infra/seeds/seed.ts and bootstrap-superadmin.ts. */
  mustChangePassword: boolean;
  /** `null` for the HTTP invite path (the account isn't onboarded yet -- see
   * `activatedAt`); a real timestamp for seed/bootstrap accounts, which are created
   * already-activated because nothing ever sends them an invitation link. */
  activatedAt: Date | null;
  invitedAt: Date | null;
}

export interface UserRepositoryPort {
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  findByTenant(tenantId: string): Promise<User[]>;
  /** Also inserts the account's first `PasswordHistory` row, in the same transaction as the
   * user itself -- otherwise a brand-new account's first self-service change would have no
   * history at all and could trivially "rotate" straight back to the temp password an admin
   * just set. */
  create(data: CreateUserData): Promise<User>;
  activateMfa(userId: string): Promise<void>;
  recordLogin(userId: string): Promise<void>;
  lock(userId: string): Promise<void>;
  unlock(userId: string): Promise<void>;
  /**
   * The one write path for changing a password, used by every setting flow (self-service
   * reset, the forced in-band change, and admin reset). One `$transaction` that: updates
   * `passwordHash`/`passwordChangedAt`/`sessionsRevokedAt` (to "now") and `mustChangePassword`
   * (to the caller's `mustChangePassword`), inserts a new `PasswordHistory` row, and prunes
   * that history back down to `PASSWORD_HISTORY_DEPTH`. Transactional so there is no window
   * where the password changed but its history/revocation didn't, or vice versa.
   *
   * Sessions are revoked unconditionally, for every caller -- the simplest rule to reason
   * about, and what a user expects ("changing my password signs me out elsewhere"). The
   * caller that performed the change mints its own fresh tokens afterward, so it is never
   * the one ejected by this.
   */
  setPassword(userId: string, passwordHash: string, options: { mustChangePassword: boolean }): Promise<void>;
  /** Most-recent-first, capped at `limit` -- see PASSWORD_HISTORY_DEPTH. Used to enforce
   * reuse prevention before `setPassword` is ever called; never used to display a hash
   * anywhere. */
  recentPasswordHashes(userId: string, limit: number): Promise<string[]>;
  /**
   * Redeems an invitation: sets the account's first real password and `activatedAt`, in
   * one write with the same shape as `setPassword` (history row included) -- see
   * `ActivateAccountHandler`. `mustChangePassword` is always left `false`: the user just
   * chose this themselves, nothing forces them to change it again.
   */
  activate(userId: string, passwordHash: string): Promise<void>;
  /**
   * Batched display-name lookup, keyed by user id -- a user with no `firstName`/`lastName`
   * (legacy/seed accounts) falls back to their email's local part, same convention as
   * `UnitRepositoryPort.summarizeTechnicalManagers`. Missing ids (a user that no longer
   * exists -- which in practice never happens, since this codebase never hard-deletes a
   * `User`, see docs/architecture.md) are simply absent from the returned record rather than
   * mapped to a placeholder string, so callers can distinguish "not found" from "found, no
   * name" and fall back however fits their own UI (see `SessionParticipantNameService`).
   */
  summarizeDisplayNames(userIds: string[]): Promise<Record<string, string>>;
  /**
   * Same batched lookup as `summarizeDisplayNames`, plus `professionalRegistration` --
   * added for `SessionParticipantNameService.resolveOperatorProfiles`'s own need (the
   * nursing screen's "Operador Remoto" card: name *and* CRBM/COREN together), kept as its
   * own method rather than widening `summarizeDisplayNames` for every existing caller
   * (`resolveUserName`'s `controllerName` has no use for a registration number at all).
   */
  summarizeProfiles(userIds: string[]): Promise<Record<string, { name: string; professionalRegistration: string | null }>>;
}
