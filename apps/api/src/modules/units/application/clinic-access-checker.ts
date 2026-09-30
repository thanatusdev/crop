import { Inject, Injectable } from "@nestjs/common";
import { TenantType, UserRole } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../shared/domain/errors.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../tenants/application/ports/tenant-repository.port.js";
import { USER_CLINIC_MEMBERSHIP_REPOSITORY, type UserClinicMembershipRepositoryPort } from "../../iam/application/ports/user-clinic-membership.port.js";
import { OperatorAccessService } from "../../access/application/operator-access.service.js";

/**
 * Who may act on a given clinic's units -- the same shape of check
 * `RegisterUserHandler` already does for clinic assignment, but reusable here since
 * `UnitsController`'s `clinicTenantId` is a genuinely independent request parameter (unlike
 * `EquipmentController`, which only ever acts on the caller's own `user.tenantId` and so
 * never needed this). `actingRole === null` is the seed/bootstrap exemption, same reasoning
 * as `canGrantRole`'s own.
 *
 * A clinic must exist, be type `CLINIC`, and be *active* -- this last check was missing
 * until now, despite `CreateUnitHandler`'s own comment already claiming it happened: a unit
 * could be created under a deactivated clinic, silently contradicting the business rule
 * that a unit is always linked to a real, registered clinic. Unlike the actor checks below
 * (which branch on *who* is asking), this one applies to every actor, PLATFORM_ADMIN
 * included -- it is not a permission question, it is "is this clinic even eligible to have
 * units managed" at all, the same way `assertCanAccessClinic` already refuses to let
 * anyone -- PLATFORM_ADMIN or not -- act on a non-CLINIC tenant.
 *
 * Once past that, a caller may act on `clinicTenantId` if:
 *   - they're PLATFORM_ADMIN, or
 *   - it's their own home tenant, or
 *   - they have a real `UserClinicMembership` row for it, or
 *   - their own tenant holds an ACTIVE `OperatorAgreement` with it -- "one operator company can
 *     work in more than one clinic", now expressed as a real contract rather than the single
 *     `Tenant.operatorTenantId` column this check used to read.
 *
 * Note this answers a question about the *relationship*, not about any particular scanner: an
 * agreement's per-unit/per-equipment scope is enforced separately by `OperatorAccessService`,
 * where the caller has actually named something. Keeping the two apart matters -- a contracted
 * operator with a narrow scope is still legitimately "linked to" the clinic, and should be told
 * that a specific device is out of scope rather than that they have no relationship with the
 * clinic at all.
 */
@Injectable()
export class ClinicAccessChecker {
  constructor(
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort,
    @Inject(USER_CLINIC_MEMBERSHIP_REPOSITORY) private readonly memberships: UserClinicMembershipRepositoryPort,
    private readonly operatorAccess: OperatorAccessService
  ) {}

  async assertCanAccessClinic(
    clinicTenantId: string,
    actor: { userId: string; tenantId: string; role: UserRole } | null
  ): Promise<void> {
    const clinic = await this.tenants.findById(clinicTenantId);
    if (!clinic) throw new NotFoundError("Tenant", clinicTenantId);
    if (clinic.type !== TenantType.CLINIC) {
      throw new ForbiddenError(`Tenant ${clinicTenantId} is not a clinic`);
    }
    if (clinic.isDeactivated()) {
      throw new ForbiddenError(`Clinic ${clinicTenantId} is deactivated`);
    }

    if (actor === null || actor.role === UserRole.PLATFORM_ADMIN) return;
    if (actor.tenantId === clinicTenantId) return;
    if (await this.memberships.isMember(actor.userId, clinicTenantId)) return;
    if (await this.operatorAccess.hasActiveAgreement(actor.tenantId, clinicTenantId)) return;

    throw new ForbiddenError(`You are not linked to clinic ${clinicTenantId}`);
  }
}
