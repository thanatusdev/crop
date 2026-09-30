import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction, TenantType } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../../../tenants/application/ports/tenant-repository.port.js";
import { TOKEN_SERVICE, type TokenServicePort } from "../../ports/token-service.port.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { USER_CLINIC_MEMBERSHIP_REPOSITORY, type UserClinicMembershipRepositoryPort } from "../../ports/user-clinic-membership.port.js";
import { OperatorAccessService } from "../../../../access/application/operator-access.service.js";
import { SwitchActiveClinicCommand, type SwitchActiveClinicResult } from "./switch-active-clinic.command.js";

/**
 * Mints a fresh token pair with a *different* `tenantId` claim than the one the caller is
 * currently authenticated with -- the "active clinic" a multi-clinic Manager/Supervisor/
 * Nursing account is currently working in (see `AccessTokenClaims`'s own comment on what
 * `tenantId` now means). Every existing `belongsToTenant` check across the app keeps
 * working unmodified: from their point of view this is just "a different, equally valid
 * tenantId", not a new concept.
 *
 * Since the role-model inversion (see packages/shared/src/roles.ts) this is also the
 * mechanism by which a *contracted operator* reaches a clinic at all. An OPERATOR now lives
 * in an OPERATOR_PROVIDER tenant and therefore never satisfies `belongsToTenant` for any
 * clinic's equipment; switching into the clinic's context is what makes all 30 of those
 * single-tenant checks keep working without modification, which is precisely why this path
 * was chosen over threading a cross-tenant authorization argument through every handler.
 *
 * So there are now two ways to be linked to a clinic, and both are accepted below:
 *   - a `UserClinicMembership` row -- a clinic-side account that works at this clinic;
 *   - an ACTIVE `OperatorAgreement` between the caller's own tenant and this clinic -- an
 *     operating company contracted to run its equipment remotely.
 *
 * The second replaced a `Tenant.operatorTenantId` check, which could only ever express one
 * operating company per clinic and had no accept/reject handshake behind it. It is also exactly
 * the case `ClinicAccessChecker` already allowed for units, so accepting it here closes a real
 * inconsistency rather than inventing a new rule: access granted there was previously unusable,
 * meaning an operator could be authorized to see a clinic's units yet unable to obtain a token
 * scoped to that clinic to do it with.
 */
@CommandHandler(SwitchActiveClinicCommand)
export class SwitchActiveClinicHandler implements ICommandHandler<SwitchActiveClinicCommand, SwitchActiveClinicResult> {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort,
    @Inject(USER_CLINIC_MEMBERSHIP_REPOSITORY) private readonly memberships: UserClinicMembershipRepositoryPort,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenServicePort,
    private readonly operatorAccess: OperatorAccessService,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: SwitchActiveClinicCommand): Promise<SwitchActiveClinicResult> {
    const user = await this.users.findById(command.userId);
    if (!user) throw new NotFoundError("User", command.userId);

    // The clinic is loaded *before* the authorization check, unlike the original order: one
    // of the two ways to be linked (the operator contract) is a property of the clinic row
    // itself, so it cannot be evaluated without it. For a caller who is genuinely not
    // linked, the outcome is unchanged -- a real clinic they have no claim on still returns
    // FORBIDDEN, and only a genuinely nonexistent id now reports NOT_FOUND instead.
    const clinic = await this.tenants.findById(command.targetClinicTenantId);
    if (!clinic) throw new NotFoundError("Tenant", command.targetClinicTenantId);
    if (clinic.type !== TenantType.CLINIC) {
      throw new ForbiddenError("Target is not a clinic");
    }
    if (clinic.isDeactivated()) {
      throw new ForbiddenError("This clinic's access has been deactivated. Contact your administrator.");
    }

    const isLinked =
      user.tenantId === command.targetClinicTenantId ||
      (await this.memberships.isMember(command.userId, command.targetClinicTenantId)) ||
      (await this.operatorAccess.hasActiveAgreement(user.tenantId, command.targetClinicTenantId));
    if (!isLinked) {
      throw new ForbiddenError("You are not linked to that clinic");
    }

    const accessToken = this.tokens.signAccessToken({
      sub: user.id,
      tenantId: command.targetClinicTenantId,
      role: user.role,
      clientOs: command.clientOs,
      // The one place these two genuinely differ. `tenantId` becomes the clinic being entered so
      // every `belongsToTenant` check keeps working; `homeTenantId` stays the account's own tenant
      // so `OperatorAccessService` can still tell an outside company apart from the clinic's own
      // staff -- both of whom now carry the same `tenantId`.
      homeTenantId: user.tenantId,
    });
    const refreshToken = this.tokens.signRefreshToken({
      sub: user.id,
      tenantId: command.targetClinicTenantId,
      clientOs: command.clientOs,
    });

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: command.targetClinicTenantId,
        userId: user.id,
        sessionId: null,
        action: AuditAction.ACTIVE_CLINIC_SWITCHED,
        resourceType: "User",
        resourceId: user.id,
        details: { fromTenantId: user.tenantId },
      })
    );

    return { accessToken, refreshToken };
  }
}
