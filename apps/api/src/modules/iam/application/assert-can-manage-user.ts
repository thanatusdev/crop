import { canGrantRole, type UserRole } from "@crop/shared";
import { ForbiddenError } from "../../../shared/domain/errors.js";
import { ROLE_LABELS_PT_BR, labelOf } from "../../../shared/domain/pt-br-labels.js";

/**
 * An admin may act on an account (lock, unlock, reset its password) only if they could have
 * created one with that role -- the same `canGrantRole` gate UpdateUserHandler applies before
 * any edit. Without it, every admin role reaching UsersController could act on anyone in its
 * tenant: a LOCAL_SUPERVISOR locking out the CLINIC_ADMIN, say.
 */
export function assertCanManageUser(actingRole: UserRole, targetRole: UserRole): void {
  if (!canGrantRole(actingRole, targetRole)) {
    throw new ForbiddenError(
      `O perfil ${labelOf(ROLE_LABELS_PT_BR, actingRole)} não pode gerenciar usuários com o perfil ${labelOf(ROLE_LABELS_PT_BR, targetRole)}.`
    );
  }
}
