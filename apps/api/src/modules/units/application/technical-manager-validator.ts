import { Inject, Injectable } from "@nestjs/common";
import { ForbiddenError, NotFoundError, ValidationError } from "../../../shared/domain/errors.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../iam/application/ports/user-repository.port.js";
import { isEligibleTechnicalManager, TECHNICAL_MANAGER_ELIGIBLE_ROLES } from "./technical-manager-eligibility.js";

/**
 * Validates a "Gestor Técnico Local" choice on create/update, shared by both handlers so
 * the rule can't drift between the two paths the way `ClinicAccessChecker` is shared for
 * the same reason.
 *
 * **Documented limitation**, inherited from `GET /users` itself: eligibility is checked
 * against the candidate's *home* tenant (`user.tenantId === clinicTenantId`), the same
 * scoping `UsersController`/`ListUsersByTenantQuery` already use everywhere else. A
 * multi-clinic manager whose home tenant is a *different* clinic (reachable only through a
 * `UserClinicMembership` row) will be rejected here even though they can otherwise act on
 * this clinic. Fixing that needs a membership-aware lookup this feature doesn't add
 * speculatively; see `ListTechnicalManagerOptionsHandler`'s own note for where candidates
 * come from in the first place.
 */
@Injectable()
export class TechnicalManagerValidator {
  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort) {}

  async assertEligible(userId: string, clinicTenantId: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError("User", userId);

    if (user.tenantId !== clinicTenantId) {
      throw new ForbiddenError(`User ${userId} does not belong to clinic ${clinicTenantId}`);
    }
    if (!isEligibleTechnicalManager(user)) {
      throw new ValidationError(
        `User ${userId} does not hold an eligible role for technical manager (${TECHNICAL_MANAGER_ELIGIBLE_ROLES.join(", ")})`
      );
    }
    if (!user.isActivated()) {
      throw new ValidationError(`User ${userId} has not activated their account yet`);
    }
    if (user.isLocked()) {
      throw new ValidationError(`User ${userId}'s account is locked`);
    }
  }
}
