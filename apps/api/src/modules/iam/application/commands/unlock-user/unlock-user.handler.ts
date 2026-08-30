import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { UnlockUserCommand } from "./unlock-user.command.js";

@CommandHandler(UnlockUserCommand)
export class UnlockUserHandler implements ICommandHandler<UnlockUserCommand, void> {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: UnlockUserCommand): Promise<void> {
    const target = await this.users.findById(command.targetUserId);
    if (!target) throw new NotFoundError("User", command.targetUserId);

    if (!target.belongsToTenant(command.actingAdminTenantId)) {
      throw new ForbiddenError("User does not belong to your tenant");
    }

    if (!target.isLocked()) return; // idempotent

    await this.users.unlock(target.id);
    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: target.tenantId,
        userId: command.actingAdminId,
        sessionId: null,
        action: AuditAction.ACCOUNT_UNLOCKED,
        resourceType: "User",
        resourceId: target.id,
        details: { targetEmail: target.email },
      })
    );
  }
}
