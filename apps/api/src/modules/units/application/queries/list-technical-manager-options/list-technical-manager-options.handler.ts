import { Inject } from "@nestjs/common";
import { QueryHandler, type IQueryHandler } from "@nestjs/cqrs";
import type { TechnicalManagerOption } from "@crop/shared";
import { ClinicAccessChecker } from "../../clinic-access-checker.js";
import { isEligibleTechnicalManager } from "../../technical-manager-eligibility.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../../../iam/application/ports/user-repository.port.js";
import { ListTechnicalManagerOptionsQuery } from "./list-technical-manager-options.query.js";

/**
 * Who the unit registration/edit form's "Gestor Técnico Local" picker offers: this clinic's
 * own activated, unlocked users holding one of `TECHNICAL_MANAGER_ELIGIBLE_ROLES`.
 *
 * Sourced from `USER_REPOSITORY.findByTenant(clinicTenantId)` -- the exact scoping
 * `GET /users` already uses (a user's *home* tenant, not every clinic they're a member
 * of). See `TechnicalManagerValidator`'s own docstring for the documented consequence: a
 * multi-clinic manager whose home tenant is elsewhere won't appear here either, even
 * though they might otherwise be eligible to act on this clinic.
 */
@QueryHandler(ListTechnicalManagerOptionsQuery)
export class ListTechnicalManagerOptionsHandler implements IQueryHandler<ListTechnicalManagerOptionsQuery, TechnicalManagerOption[]> {
  constructor(
    private readonly clinicAccess: ClinicAccessChecker,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort
  ) {}

  async execute(query: ListTechnicalManagerOptionsQuery): Promise<TechnicalManagerOption[]> {
    await this.clinicAccess.assertCanAccessClinic(query.clinicTenantId, {
      userId: query.requestingUserId,
      tenantId: query.requestingTenantId,
      role: query.requestingRole,
    });

    const users = await this.users.findByTenant(query.clinicTenantId);
    return users
      .filter((user) => isEligibleTechnicalManager(user) && user.isActivated() && !user.isLocked())
      .map((user) => {
        const full = [user.firstName, user.lastName].filter((part): part is string => !!part).join(" ");
        return {
          id: user.id,
          name: full.length > 0 ? full : user.email.split("@")[0]!,
          email: user.email,
          role: user.role,
          professionalRegistration: user.professionalRegistration,
        };
      });
  }
}
