import { randomBytes } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction, TenantType, UserRole, canGrantRole, isRoleAllowedInTenantType, requiresClinicAssignment } from "@crop/shared";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../../../tenants/application/ports/tenant-repository.port.js";
import { PASSWORD_HASHER, type PasswordHasherPort } from "../../ports/password-hasher.port.js";
import { MFA_SERVICE, type MfaServicePort } from "../../ports/mfa-service.port.js";
import { TOKEN_SERVICE, type TokenServicePort } from "../../ports/token-service.port.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { USER_CLINIC_MEMBERSHIP_REPOSITORY, type UserClinicMembershipRepositoryPort } from "../../ports/user-clinic-membership.port.js";
import { assertPasswordPolicy } from "../../enforce-password-policy.js";
import { RegisterUserCommand, type RegisterUserResult } from "./register-user.command.js";

@CommandHandler(RegisterUserCommand)
export class RegisterUserHandler implements ICommandHandler<RegisterUserCommand, RegisterUserResult> {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort,
    @Inject(USER_CLINIC_MEMBERSHIP_REPOSITORY) private readonly memberships: UserClinicMembershipRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(MFA_SERVICE) private readonly mfa: MfaServicePort,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenServicePort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: RegisterUserCommand): Promise<RegisterUserResult> {
    const existing = await this.users.findByEmail(command.email);
    if (existing) {
      throw new ConflictError(`A user with email ${command.email} already exists`);
    }

    // "The System Administrator registers users with the Clinic Manager, Supervisor, and
    // Nursing profiles. The Clinic Manager registers users with the Nursing profile." --
    // see roles.ts's own docstring on `ROLE_GRANTS`/`canGrantRole` for the full matrix.
    // `actingRole === null` is the seed/bootstrap exemption: those dispatch this command
    // directly through the CommandBus, bypassing HTTP (and this check) entirely.
    if (!canGrantRole(command.actingRole, command.role)) {
      throw new ForbiddenError(`${command.actingRole ?? "this caller"} may not register a ${command.role} account`);
    }

    // The first (and, as of this handler, only) place a user's role is checked against their
    // tenant's type (see packages/shared/src/roles.ts) -- e.g. a NURSING user cannot be
    // created in an OPERATOR_PROVIDER tenant, and PLATFORM_ADMIN only ever belongs to the
    // one PLATFORM tenant bootstrap-superadmin.ts creates for itself. Enforced here, not in
    // UsersController, so infra/seeds/seed.ts and bootstrap-superadmin.ts -- which both
    // dispatch this command directly through the CommandBus, bypassing HTTP entirely -- are
    // covered too.
    const homeTenant = await this.tenants.findById(command.tenantId);
    if (!homeTenant) {
      throw new NotFoundError("Tenant", command.tenantId);
    }
    if (!isRoleAllowedInTenantType(command.role, homeTenant.type)) {
      throw new ForbiddenError(`Role ${command.role} is not permitted in a ${homeTenant.type} tenant`);
    }

    // Rule: "A Manager is linked to one or more clinics. A Supervisor is linked to the
    // clinic(s) of the responsible Manager." -- validated here, not just shaped by Zod at
    // the HTTP boundary, so seed scripts are covered too (see requiresClinicAssignment's
    // own docstring for exactly which roles this applies to).
    const extraClinicIds = [...new Set(command.clinicTenantIds)].filter((id) => id !== command.tenantId);
    if (requiresClinicAssignment(command.role)) {
      if (command.clinicTenantIds.length === 0) {
        throw new ValidationError(`role ${command.role} requires at least one clinicTenantId`);
      }

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

      // Actor scope: PLATFORM_ADMIN may link any clinic; every other caller (a CLINIC_ADMIN
      // registering a Supervisor or Nursing account) may only link clinics they themselves
      // already belong to. `actingUserId`/`actingRole` are both null for the seed/bootstrap
      // exemption, which skips this the same way it skips `canGrantRole`.
      if (command.actingUserId && command.actingRole && command.actingRole !== UserRole.PLATFORM_ADMIN) {
        const actorClinicIds = new Set(await this.memberships.listClinicIdsForUser(command.actingUserId));
        for (const clinicId of [command.tenantId, ...extraClinicIds]) {
          if (!actorClinicIds.has(clinicId)) {
            throw new ForbiddenError(`You are not linked to clinic ${clinicId}`);
          }
        }
      }

      // Rule 2, the actual constraint: a Supervisor's clinic must already have a
      // responsible Manager -- enforced as "already has a CLINIC_ADMIN member", not a
      // dedicated `responsibleManagerId` FK (see roles.ts's own docstring).
      if (command.role === UserRole.LOCAL_SUPERVISOR) {
        for (const clinicId of [command.tenantId, ...extraClinicIds]) {
          const hasManager = await this.memberships.hasMemberWithRole(clinicId, UserRole.CLINIC_ADMIN);
          if (!hasManager) {
            throw new ForbiddenError(`Clinic ${clinicId} has no Clinic Manager yet -- a Supervisor cannot be linked to it`);
          }
        }
      }
    }

    // Two onboarding paths (see RegisterUserCommand's own docstring): `directActivation`
    // (seed/bootstrap, a real password known up front, account usable immediately) vs. the
    // HTTP invite path (no password set here at all -- a random, permanently-unusable
    // placeholder hash, and the account cannot log in until ActivateAccountHandler runs).
    let passwordHash: string;
    let activatedAt: Date | null;
    let invitedAt: Date | null;
    if (command.directActivation) {
      // Same policy check every other password-setting path enforces (see
      // enforce-password-policy.ts) -- a seed-known password containing the new account's
      // own name is exactly as guessable as a self-chosen one would be. No reuse check
      // here: there is no history yet for an account that doesn't exist until `create()`.
      assertPasswordPolicy(command.directActivation.password, { email: command.email, firstName: command.firstName, lastName: command.lastName });
      passwordHash = await this.hasher.hash(command.directActivation.password);
      activatedAt = new Date();
      invitedAt = null;
    } else {
      // Never logged in with, never emailed, never displayed -- this hash exists only so
      // `passwordHash` can stay a required, non-null column. LoginHandler's own
      // `isActivated()` check rejects the account long before this value would ever be
      // compared against anything.
      passwordHash = await this.hasher.hash(randomBytes(32).toString("hex"));
      activatedAt = null;
      invitedAt = new Date();
    }

    const { secret, provisioningUri } = this.mfa.generateSecret(command.email);

    const user = await this.users.create({
      tenantId: command.tenantId,
      email: command.email,
      passwordHash,
      role: command.role,
      mfaSecret: secret,
      firstName: command.firstName,
      lastName: command.lastName,
      professionalRegistration: command.professionalRegistration,
      mustChangePassword: false,
      activatedAt,
      invitedAt,
    });

    if (!command.active) {
      await this.users.lock(user.id);
    }

    // Membership only exists for clinic-side accounts (see UserClinicMembershipRepositoryPort's
    // own docstring) -- an OPERATOR_PROVIDER or PLATFORM home tenant has no "clinics this
    // user can reach" concept at all.
    if (homeTenant.type === TenantType.CLINIC) {
      await this.memberships.grant(user.id, [command.tenantId, ...extraClinicIds]);
    }

    // userId: null for the seed script / bootstrap-superadmin.ts (no human admin acting) --
    // this was a real, separate gap found while building the tenants feature: POST /users
    // (added last phase) emitted no audit event at all, for any role.
    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: user.tenantId,
        userId: command.actingUserId,
        sessionId: null,
        action: AuditAction.USER_CREATED,
        resourceType: "User",
        resourceId: user.id,
        details: { email: user.email, role: user.role, clinicTenantIds: [command.tenantId, ...extraClinicIds] },
      })
    );

    // Mandatory 2FA (docs/architecture.md): no access or refresh token is issued here.
    // The account cannot authenticate until MfaEnrollConfirmCommand activates this secret
    // (and, on the HTTP invite path, not even then -- it must also be activated first).
    return {
      userId: user.id,
      enrollmentToken: this.tokens.signMfaEnrollment(user.id),
      provisioningUri,
    };
  }
}
