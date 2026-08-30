import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { ConflictError } from "../../../../../shared/domain/errors.js";
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
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenServicePort
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

    // Mandatory 2FA (docs/architecture.md): no access or refresh token is issued here.
    // The account cannot authenticate until MfaEnrollConfirmCommand activates this secret.
    return {
      userId: user.id,
      enrollmentToken: this.tokens.signMfaEnrollment(user.id),
      provisioningUri,
    };
  }
}
