import { Inject, Injectable } from "@nestjs/common";
import { responsibleManagerRoleFor } from "@crop/shared";
import { ForbiddenError, NotFoundError, ValidationError } from "../../../shared/domain/errors.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "./ports/tenant-repository.port.js";

/**
 * Validates a "Gestor Responsável" choice on create/update, the tenant-side counterpart to
 * `TechnicalManagerValidator` -- same shape, narrower eligibility: only the one role
 * `responsibleManagerRoleFor(tenant.type)` names (`CLINIC_ADMIN` for a `CLINIC`,
 * `OPERATOR_ADMIN` for an `OPERATOR_PROVIDER`), not a set of roles. "Gestor Responsável" is
 * this feature's reading of the prototype's own "Administrador" label next to that field,
 * and a tenant's overall accountable person is a narrower thing than a unit's day-to-day
 * technical manager.
 *
 * Reaches into `TENANT_REPOSITORY.findResponsibleManagerCandidate` rather than injecting
 * `USER_REPOSITORY` the way `TechnicalManagerValidator` does -- `IamModule` already imports
 * `TenantsModule` (for `TENANT_REPOSITORY` itself), so the reverse import would be a module
 * cycle; see that port method's own docstring.
 *
 * **Documented limitation**, inherited from the identical unit-side one: eligibility is
 * checked against the candidate's *home* tenant, the same scoping `GET /users` already
 * uses everywhere else. A multi-clinic manager whose home tenant is a different clinic
 * (reachable only through a `UserClinicMembership` row) is rejected here even though they
 * can otherwise act on this clinic.
 */
@Injectable()
export class ResponsibleManagerValidator {
  constructor(@Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort) {}

  async assertEligible(userId: string, tenantId: string): Promise<void> {
    const tenant = await this.tenants.findById(tenantId);
    if (!tenant) throw new NotFoundError("Tenant", tenantId);
    const expectedRole = responsibleManagerRoleFor(tenant.type);
    if (!expectedRole) {
      throw new ValidationError(`Tenant ${tenantId} of type ${tenant.type} has no responsible-manager concept`);
    }

    const candidate = await this.tenants.findResponsibleManagerCandidate(userId);
    if (!candidate) throw new NotFoundError("User", userId);

    if (candidate.tenantId !== tenantId) {
      throw new ForbiddenError(`User ${userId} does not belong to tenant ${tenantId}`);
    }
    if (candidate.role !== expectedRole) {
      throw new ValidationError(`User ${userId} does not hold an eligible role for responsible manager (${expectedRole})`);
    }
    if (!candidate.activatedAt) {
      throw new ValidationError(`User ${userId} has not activated their account yet`);
    }
    if (candidate.lockedAt) {
      throw new ValidationError(`User ${userId}'s account is locked`);
    }
  }
}
