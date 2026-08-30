import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { NotFoundError, UnauthorizedError } from "../../../../../shared/domain/errors.js";
import { MFA_SERVICE, type MfaServicePort } from "../../ports/mfa-service.port.js";
import { TOKEN_SERVICE, type TokenServicePort } from "../../ports/token-service.port.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { ConfirmMfaEnrollmentCommand } from "./confirm-mfa-enrollment.command.js";

@CommandHandler(ConfirmMfaEnrollmentCommand)
export class ConfirmMfaEnrollmentHandler implements ICommandHandler<ConfirmMfaEnrollmentCommand, void> {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(MFA_SERVICE) private readonly mfa: MfaServicePort,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenServicePort
  ) {}

  async execute(command: ConfirmMfaEnrollmentCommand): Promise<void> {
    const { sub: userId } = this.tokens.verifyMfaEnrollment(command.enrollmentToken);

    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError("User", userId);

    const secret = user.mfaSecret;
    if (!secret || !this.mfa.verifyCode(secret, command.code)) {
      throw new UnauthorizedError("Invalid enrollment code");
    }

    await this.users.activateMfa(userId);
  }
}
