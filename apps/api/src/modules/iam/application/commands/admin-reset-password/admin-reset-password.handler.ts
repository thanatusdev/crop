import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { ConfigService } from "@nestjs/config";
import { AuditAction } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { PASSWORD_HASHER, type PasswordHasherPort } from "../../ports/password-hasher.port.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { assertPasswordNotReused, assertPasswordPolicy } from "../../enforce-password-policy.js";
import { AdminResetPasswordCommand } from "./admin-reset-password.command.js";

/**
 * The admin-driven counterpart to RequestPasswordResetHandler/ResetPasswordHandler's
 * self-service, email-link flow: a self-service reset now exists (see those two handlers'
 * docstrings for why that decision reversed once a mailer was added), but it's useless to a
 * user who's lost access to their inbox too, or whose admin wants to act without waiting for
 * them to click a link at all.
 *
 * Now revokes sessions AND forces a change on the target's next login -- this reverses what
 * used to be documented here as deliberate ("does NOT revoke... orthogonal to locking").
 * That was correct reasoning at the time, when the only alternative to an admin-set password
 * being a *lasting* credential was nothing at all. It stopped being correct once
 * ChangePasswordHandler existed: an admin-set password is now always a way back in, never a
 * long-term one, the exact same shape as a brand-new account's temp password
 * (`RegisterUserHandler`'s own `mustChangePassword: true`). Locking a device out for a
 * *suspected compromise* is still LockUserCommand's separate job -- this handler answers "I
 * need to get this person logged in again," not "I need to stop them."
 */
@CommandHandler(AdminResetPasswordCommand)
export class AdminResetPasswordHandler implements ICommandHandler<AdminResetPasswordCommand, void> {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    private readonly config: ConfigService,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: AdminResetPasswordCommand): Promise<void> {
    const target = await this.users.findById(command.targetUserId);
    if (!target) throw new NotFoundError("User", command.targetUserId);

    if (!target.belongsToTenant(command.actingAdminTenantId)) {
      throw new ForbiddenError("User does not belong to your tenant");
    }

    // Same two checks every other password-setting path enforces -- see
    // enforce-password-policy.ts. An admin picking the new password is not exempt from
    // either: a temp password containing the target's own name is exactly as guessable as
    // one the target chose themselves, and reuse prevention exists to stop a rotate-back
    // regardless of who typed it in.
    assertPasswordPolicy(command.newPassword, { email: target.email, firstName: target.firstName, lastName: target.lastName });
    const historyDepth = this.config.get<number>("PASSWORD_HISTORY_DEPTH", 5);
    await assertPasswordNotReused(command.newPassword, target.id, { users: this.users, hasher: this.hasher }, historyDepth);

    const passwordHash = await this.hasher.hash(command.newPassword);
    await this.users.setPassword(target.id, passwordHash, { mustChangePassword: true });

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
