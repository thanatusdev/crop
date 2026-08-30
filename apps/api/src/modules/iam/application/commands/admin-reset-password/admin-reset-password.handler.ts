import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { PASSWORD_HASHER, type PasswordHasherPort } from "../../ports/password-hasher.port.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { AdminResetPasswordCommand } from "./admin-reset-password.command.js";

/**
 * There is no self-service "forgot password" flow (see docs/architecture.md): user
 * provisioning is already an out-of-band admin action (RegisterUserCommand has no HTTP
 * endpoint at all -- only the seed script calls it), so a lost password is handled the same
 * administrative way, with no email/SMTP dependency to build or secure.
 *
 * Deliberately does NOT revoke the target's existing refresh tokens or lock the account --
 * those are LockUserCommand's job, orthogonal to this one. An admin responding to a leaked
 * credential should call both; an admin just helping someone who forgot their password only
 * needs this one.
 */
@CommandHandler(AdminResetPasswordCommand)
export class AdminResetPasswordHandler implements ICommandHandler<AdminResetPasswordCommand, void> {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: AdminResetPasswordCommand): Promise<void> {
    const target = await this.users.findById(command.targetUserId);
    if (!target) throw new NotFoundError("User", command.targetUserId);

    if (!target.belongsToTenant(command.actingAdminTenantId)) {
      throw new ForbiddenError("User does not belong to your tenant");
    }

    const passwordHash = await this.hasher.hash(command.newPassword);
    await this.users.updatePasswordHash(target.id, passwordHash);

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: target.tenantId,
        userId: command.actingAdminId,
        sessionId: null,
        action: AuditAction.PASSWORD_RESET_BY_ADMIN,
        resourceType: "User",
        resourceId: target.id,
        details: { targetEmail: target.email },
      })
    );
  }
}
