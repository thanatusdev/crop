import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction, TenantType, UserRole, canGrantRole, isRoleAllowedInTenantType, requiresClinicAssignment, responsibleManagerRoleFor } from "@crop/shared";
import { ForbiddenError, NotFoundError, ValidationError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../../../tenants/application/ports/tenant-repository.port.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { USER_CLINIC_MEMBERSHIP_REPOSITORY, type UserClinicMembershipRepositoryPort } from "../../ports/user-clinic-membership.port.js";
import { User } from "../../../domain/user.entity.js";
import { UpdateUserCommand } from "./update-user.command.js";

@CommandHandler(UpdateUserCommand)
export class UpdateUserHandler implements ICommandHandler<UpdateUserCommand, User> {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort,
    @Inject(USER_CLINIC_MEMBERSHIP_REPOSITORY) private readonly memberships: UserClinicMembershipRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: UpdateUserCommand): Promise<User> {
    const target = await this.users.findById(command.targetUserId);
    if (!target) throw new NotFoundError("User", command.targetUserId);

    // Same unconditional tenant-isolation check LockUserHandler/UnlockUserHandler/
    // AdminResetPasswordHandler already use -- no PLATFORM_ADMIN bypass exists for those
    // either, so none is added here: a platform admin manages a tenant's users by acting
    // *as* that tenant's own admin (switching into it), not by reaching across tenants from
    // the PLATFORM one. See UsersController's own docstring on the "tenant-scoped" rule this
    // mirrors.
    if (!target.belongsToTenant(command.actingAdminTenantId)) {
      throw new ForbiddenError("User does not belong to your tenant");
    }

    // Gates whether the acting admin may touch this user AT ALL, independent of which
    // fields are actually changing: checked against the user's *current* role first, so a
    // LOCAL_SUPERVISOR (who may grant NURSING/LOCAL_IT per ROLE_GRANTS) cannot use "just
    // editing the name" as a backdoor into a CLINIC_ADMIN account they have no authority
    // over. The seed/bootstrap `actingRole === null` exemption `canGrantRole` itself
    // documents does not apply here: every HTTP caller reaching this handler has a real,
    // non-null role (UsersController's own @Roles guard already guarantees that).
    if (!canGrantRole(command.actingRole, target.role)) {
      throw new ForbiddenError(`${command.actingRole} may not edit a ${target.role} account`);
    }

    const effectiveRole = command.changes.role ?? target.role;

    if (command.changes.role !== undefined && command.changes.role !== target.role) {
      // Must also be able to grant the *destination* role -- the two-sided check this
      // handler's own docstring (see UpdateUserCommand) exists for. A role never crosses a
      // tenant-type boundary without this handler knowing it: `isRoleAllowedInTenantType`
      // below rejects that regardless, since home tenant itself never changes here.
      if (!canGrantRole(command.actingRole, command.changes.role)) {
        throw new ForbiddenError(`${command.actingRole} may not grant the ${command.changes.role} role`);
      }

      const homeTenant = await this.tenants.findById(target.tenantId);
      if (!homeTenant) throw new NotFoundError("Tenant", target.tenantId);
      if (!isRoleAllowedInTenantType(command.changes.role, homeTenant.type)) {
        throw new ForbiddenError(`Role ${command.changes.role} is not permitted in a ${homeTenant.type} tenant`);
      }

      // FK guard: a role change that would leave some tenant's "Gestor Responsável"
      // pointing at someone no longer eligible for that slot must be rejected outright, not
      // silently orphan the reference -- see `TenantRepositoryPort.findByResponsibleManagerId`'s
      // own docstring. Scoped to Tenant only: the identical Unit.technicalManagerId case is
      // not checked here (would need UNIT_REPOSITORY, which IamModule does not import, to
      // avoid the same module-cycle TenantsModule/UnitsModule already navigate around each
      // other -- a documented gap, not an oversight).
      const responsibleFor = await this.tenants.findByResponsibleManagerId(target.id);
      if (responsibleFor && responsibleManagerRoleFor(responsibleFor.type) !== command.changes.role) {
        throw new ForbiddenError(
          `User ${target.id} is the responsible manager for tenant ${responsibleFor.id} -- unassign them there before changing their role`
        );
      }
    }

    // clinicTenantIds: only touched when explicitly present in the patch (a partial update
    // leaves membership alone otherwise) -- same shape as every other optional field here.
    if (command.changes.clinicTenantIds !== undefined) {
      const extraClinicIds = [...new Set(command.changes.clinicTenantIds)].filter((id) => id !== target.tenantId);

      for (const clinicId of extraClinicIds) {
        const clinic = await this.tenants.findById(clinicId);
        if (!clinic) throw new NotFoundError("Tenant", clinicId);
        if (clinic.type !== TenantType.CLINIC) {
          throw new ForbiddenError(`Tenant ${clinicId} is not a clinic`);
        }
        if (clinic.isDeactivated()) {
          throw new ForbiddenError(`Clinic ${clinicId} has been deactivated`);
        }
      }

      // Actor scope: PLATFORM_ADMIN may link any clinic; every other caller may only link
      // clinics they themselves already belong to -- mirrors RegisterUserHandler's own
      // check. Unlike registration (whose controller lets a PLATFORM_ADMIN target an
      // arbitrary tenant via `body.tenantId`), this branch is currently unreachable in
      // practice: the unconditional `belongsToTenant` check above -- same as
      // LockUserHandler/UnlockUserHandler/AdminResetPasswordHandler, none of which special
      // -case PLATFORM_ADMIN either -- already stops a platform admin from reaching any
      // user outside the PLATFORM tenant before this point. Kept for the same reason
      // `canGrantRole`'s own `null`-actor exemption is kept where nothing currently calls
      // it that way: consistent with the equivalent check elsewhere, and ready if a future
      // caller (e.g. a `PATCH /users/:id` variant scoped by an explicit target tenant) ever
      // reaches it.
      if (command.actingRole !== UserRole.PLATFORM_ADMIN) {
        const actorClinicIds = new Set(await this.memberships.listClinicIdsForUser(command.actingAdminId));
        for (const clinicId of [target.tenantId, ...extraClinicIds]) {
          if (!actorClinicIds.has(clinicId)) {
            throw new ForbiddenError(`You are not linked to clinic ${clinicId}`);
          }
        }
      }

      // Rule 2, the same one RegisterUserHandler enforces: a Supervisor's clinic must
      // already have a responsible Manager.
      if (effectiveRole === UserRole.LOCAL_SUPERVISOR) {
        for (const clinicId of [target.tenantId, ...extraClinicIds]) {
          const hasManager = await this.memberships.hasMemberWithRole(clinicId, UserRole.CLINIC_ADMIN);
          if (!hasManager) {
            throw new ForbiddenError(`Clinic ${clinicId} has no Clinic Manager yet -- a Supervisor cannot be linked to it`);
          }
        }
      }

      await this.memberships.replace(target.id, [target.tenantId, ...extraClinicIds]);
    } else if (requiresClinicAssignment(effectiveRole) && command.changes.role !== undefined && command.changes.role !== target.role) {
      // Role is changing INTO a clinic-assignment role (e.g. LOCAL_IT -> NURSING) without
      // clinicTenantIds also being sent: the existing membership already has at least
      // [target.tenantId] (every clinic-type user gets that row at registration -- see
      // RegisterUserHandler), so the invariant "at least one clinic" still holds without
      // this handler having to do anything further. Nothing to validate or write here.
    }

    const updated = await this.users.update(target.id, {
      firstName: command.changes.firstName,
      lastName: command.changes.lastName,
      professionalRegistration: command.changes.professionalRegistration,
      role: command.changes.role,
    });

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: target.tenantId,
        userId: command.actingAdminId,
        sessionId: null,
        action: AuditAction.USER_UPDATED,
        resourceType: "User",
        resourceId: target.id,
        // Field *names* only -- same flat rule TENANT_UPDATED/UNIT_UPDATED/EQUIPMENT_UPDATED
        // already follow.
        details: { changedFields: Object.keys(command.changes) },
      })
    );

    return updated;
  }
}
