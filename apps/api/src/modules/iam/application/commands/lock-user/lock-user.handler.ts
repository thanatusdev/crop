import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction, UserRole } from "@crop/shared";
import { ConflictError, ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { assertCanManageUser } from "../../assert-can-manage-user.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { LockUserCommand } from "./lock-user.command.js";

/**
 * A locked account is rejected at `LoginHandler`, `VerifyMfaHandler`, and
 * `RefreshTokensHandler` -- but *not* retroactively against an access token already issued
 * before the lock (access tokens are verified by signature+expiry alone, no DB round trip;
 * see JwtAccessStrategy). A locked user's existing session therefore keeps working for at
 * most `JWT_ACCESS_TTL_SECONDS` (15 minutes by default) after this runs, not instantly.
 * That bound is the deliberate tradeoff for never adding a DB hit to every authenticated
 * request just to check a rarely-flipped flag; see docs/architecture.md.
 *
 * Nobody may lock their own account, and a PLATFORM_ADMIN is never locked if that would
 * leave its tenant without another platform admin able to sign in -- nobody else could
 * unlock them, and bootstrap-superadmin.ts refuses to run twice.
 */
@CommandHandler(LockUserCommand)
export class LockUserHandler implements ICommandHandler<LockUserCommand, void> {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: LockUserCommand): Promise<void> {
    const target = await this.users.findById(command.targetUserId);
    if (!target) throw new NotFoundError("User", command.targetUserId);

    // Same tenant-isolation pattern used throughout (GetEquipmentHandler, GetUserByIdHandler):
    // a CLINIC_ADMIN can never lock another tenant's user, even by guessing a UUID.
    if (!target.belongsToTenant(command.actingAdminTenantId)) {
      throw new ForbiddenError("Este usuário não pertence à sua organização.");
    }

    assertCanManageUser(command.actingRole, target.role);

    if (target.id === command.actingAdminId) {
      throw new ForbiddenError("Você não pode bloquear a sua própria conta.");
    }

    if (target.isLocked()) return; // idempotent: locking an already-locked account is a no-op

    if (target.role === UserRole.PLATFORM_ADMIN) {
      const locked = await this.users.lockUnlessLastActive(target.id, target.tenantId, target.role);
      if (!locked) {
        throw new ConflictError("Não é possível bloquear o último administrador da plataforma ativo.");
      }
    } else {
      await this.users.lock(target.id);
    }
    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: target.tenantId,
        userId: command.actingAdminId,
        sessionId: null,
        action: AuditAction.ACCOUNT_LOCKED,
        resourceType: "User",
        resourceId: target.id,
        details: { targetEmail: target.email },
      })
    );
  }
}
