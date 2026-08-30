import { Body, Controller, HttpCode, HttpStatus, Post, UsePipes } from "@nestjs/common";
import { CommandBus } from "@nestjs/cqrs";
import {
  LoginRequestSchema,
  MfaEnrollConfirmRequestSchema,
  MfaVerifyRequestSchema,
  RefreshRequestSchema,
  type LoginRequest,
  type LoginResponse,
  type MfaEnrollConfirmRequest,
  type MfaVerifyRequest,
  type RefreshRequest,
} from "@crop/shared";
import { ZodValidationPipe } from "../../../shared/infrastructure/http/zod-validation.pipe.js";
import { LoginCommand, type LoginResult } from "../application/commands/login/login.command.js";
import { VerifyMfaCommand } from "../application/commands/verify-mfa/verify-mfa.command.js";
import { RefreshTokensCommand } from "../application/commands/refresh-tokens/refresh-tokens.command.js";
import { LogoutCommand } from "../application/commands/logout/logout.command.js";
import { ConfirmMfaEnrollmentCommand } from "../application/commands/enroll-mfa/confirm-mfa-enrollment.command.js";

@Controller("auth")
export class AuthController {
  constructor(private readonly commandBus: CommandBus) {}

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(LoginRequestSchema))
  async login(@Body() body: LoginRequest): Promise<LoginResponse> {
    const result = await this.commandBus.execute<LoginCommand, LoginResult>(
      new LoginCommand(body.email, body.password, body.clientOs)
    );
    return result;
  }

  @Post("mfa/verify")
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(MfaVerifyRequestSchema))
  async verifyMfa(@Body() body: MfaVerifyRequest): Promise<LoginResponse> {
    const result = await this.commandBus.execute(new VerifyMfaCommand(body.mfaToken, body.code));
    return { status: "ok", ...result };
  }

  @Post("mfa/enroll/confirm")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UsePipes(new ZodValidationPipe(MfaEnrollConfirmRequestSchema))
  async confirmEnrollment(@Body() body: MfaEnrollConfirmRequest): Promise<void> {
    await this.commandBus.execute(new ConfirmMfaEnrollmentCommand(body.enrollmentToken, body.code));
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(RefreshRequestSchema))
  async refresh(@Body() body: RefreshRequest) {
    return this.commandBus.execute(new RefreshTokensCommand(body.refreshToken));
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UsePipes(new ZodValidationPipe(RefreshRequestSchema))
  async logout(@Body() body: RefreshRequest): Promise<void> {
    await this.commandBus.execute(new LogoutCommand(body.refreshToken));
  }
}
