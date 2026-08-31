import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { ConflictError } from "../../../../../shared/domain/errors.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { PASSWORD_HASHER, type PasswordHasherPort } from "../../ports/password-hasher.port.js";
import { MFA_SERVICE, type MfaServicePort } from "../../ports/mfa-service.port.js";
import { TOKEN_SERVICE, type TokenServicePort } from "../../ports/token-service.port.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { RegisterUserCommand, type RegisterUserResult } from "./register-user.command.js";

@CommandHandler(RegisterUserCommand)
export class RegisterUserHandler implements ICommandHandler<RegisterUserCommand, RegisterUserResult> {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
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

    const passwordHash = await this.hasher.hash(command.password);
    const { secret, provisioningUri } = this.mfa.generateSecret(command.email);

    const user = await this.users.create({
      tenantId: command.tenantId,
      email: command.email,
      passwordHash,
      role: command.role,
      mfaSecret: secret,
    });

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
        details: { email: user.email, role: user.role },
      })
    );

    // Mandatory 2FA (docs/architecture.md): no access or refresh token is issued here.
    // The account cannot authenticate until MfaEnrollConfirmCommand activates this secret.
    return {
      userId: user.id,
      enrollmentToken: this.tokens.signMfaEnrollment(user.id),
      provisioningUri,
    };
  }
}
