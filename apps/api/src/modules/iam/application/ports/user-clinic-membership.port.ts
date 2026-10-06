export const USER_CLINIC_MEMBERSHIP_REPOSITORY = Symbol("USER_CLINIC_MEMBERSHIP_REPOSITORY");

/**
 * Which clinics (CLINIC-type `Tenant`s) a user can reach, beyond their one "home"/active
 * clinic (`User.tenantId`, carried in the JWT -- see `AccessTokenClaims`). Only the
 * clinic-side roles (`CLINIC_ADMIN`/`LOCAL_SUPERVISOR`/`NURSING`) ever have more than one
 * row; every other role still gets exactly one, created alongside the user itself (see
 * `RegisterUserHandler`) so "which clinics can this user reach" never has to fall back to
 * "just their home tenantId" as a special case for clinic-side accounts.
 */
export interface UserClinicMembershipRepositoryPort {
  /** Replaces nothing -- additive only. Used once, at registration; `RegisterUserHandler`
   * is the only writer today. */
  grant(userId: string, clinicTenantIds: readonly string[]): Promise<void>;
  /** Whole-set replacement, not merge -- the same "send the complete desired state" shape
   * `SetAgreementScopeCommand`/`ReorderQueueRequestSchema` use, for the identical reason: a
   * partial add/remove API would need its own conflict semantics for two admins editing at
   * once, and a full replacement is idempotent with an obvious meaning. `UpdateUserHandler`
   * is the only writer -- the "edit a user's clinics" endpoint `grant`'s own docstring,
   * before this, noted did not exist yet. */
  replace(userId: string, clinicTenantIds: readonly string[]): Promise<void>;
  listClinicIdsForUser(userId: string): Promise<string[]>;
  /** Bulk form of `listClinicIdsForUser`, for rendering a user list (`GET /users`) without
   * one query per row. Every requested id is present in the result, even with an empty
   * array, so a caller never has to special-case "no rows found". */
  listClinicIdsForUsers(userIds: readonly string[]): Promise<Record<string, string[]>>;
  isMember(userId: string, clinicTenantId: string): Promise<boolean>;
  /** True if `clinicTenantId` has at least one member with `role`. Backs rule 2 ("A
   * Supervisor is linked to the clinic(s) of the responsible Manager") -- a
   * LOCAL_SUPERVISOR can only be linked to a clinic that already has a CLINIC_ADMIN. */
  hasMemberWithRole(clinicTenantId: string, role: string): Promise<boolean>;
}
