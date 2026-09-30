import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards, UsePipes } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import {
  ActivateAccountRequestSchema,
  ChangePasswordRequestSchema,
  LoginRequestSchema,
  MfaEnrollConfirmRequestSchema,
  MfaVerifyRequestSchema,
  RefreshRequestSchema,
  RequestPasswordResetRequestSchema,
  ResetPasswordRequestSchema,
  SwitchActiveClinicRequestSchema,
  type AccessTokenClaims,
  type ActivateAccountRequest,
  type ChangePasswordRequest,
  type InvitationPreview,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
  type MfaEnrollConfirmRequest,
  type MfaVerifyRequest,
  type MyClinic,
  type PasswordResetValidateResponse,
  type RefreshRequest,
  type RequestPasswordResetRequest,
  type ResetPasswordRequest,
  type SwitchActiveClinicRequest,
} from "@crop/shared";
import { ZodValidationPipe } from "../../../shared/infrastructure/http/zod-validation.pipe.js";
import { JwtAuthGuard } from "./guards/jwt-auth.guard.js";
import { CurrentUser } from "./decorators/current-user.decorator.js";
import { LoginCommand, type LoginResult } from "../application/commands/login/login.command.js";
import { VerifyMfaCommand } from "../application/commands/verify-mfa/verify-mfa.command.js";
import { RefreshTokensCommand } from "../application/commands/refresh-tokens/refresh-tokens.command.js";
import { LogoutCommand } from "../application/commands/logout/logout.command.js";
import { ConfirmMfaEnrollmentCommand } from "../application/commands/enroll-mfa/confirm-mfa-enrollment.command.js";
import { RequestPasswordResetCommand } from "../application/commands/request-password-reset/request-password-reset.command.js";
import { ResetPasswordCommand } from "../application/commands/reset-password/reset-password.command.js";
import { ChangePasswordCommand } from "../application/commands/change-password/change-password.command.js";
import { ActivateAccountCommand } from "../application/commands/activate-account/activate-account.command.js";
import { SwitchActiveClinicCommand, type SwitchActiveClinicResult } from "../application/commands/switch-active-clinic/switch-active-clinic.command.js";
import { ValidatePasswordResetTokenQuery } from "../application/queries/validate-password-reset-token/validate-password-reset-token.query.js";
import { PreviewInvitationQuery } from "../application/queries/preview-invitation/preview-invitation.query.js";
import { ListMyClinicsQuery } from "../application/queries/list-my-clinics/list-my-clinics.query.js";
import { GetMeQuery } from "../application/queries/get-me/get-me.query.js";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus
  ) {}

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
    // VerifyMfaHandler returns the full discriminated shape itself now ("ok" or
    // "password_change_required" -- see VerifyMfaResult), not just token pairs, so there's
    // nothing left for this controller to wrap.
    return this.commandBus.execute(new VerifyMfaCommand(body.mfaToken, body.code));
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

  // 200, not 204: the frontend's confirmation modal needs *something* to render regardless
  // of whether an account exists (see RequestPasswordResetHandler) -- a bare 204 would work
  // too, but an explicit 200 body leaves room to add a non-committal hint later without a
  // breaking status-code change.
  @Post("password-reset/request")
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(RequestPasswordResetRequestSchema))
  async requestPasswordReset(@Body() body: RequestPasswordResetRequest): Promise<{ status: "ok" }> {
    await this.commandBus.execute(new RequestPasswordResetCommand(body.email));
    return { status: "ok" };
  }

  // GET, not POST: purely a read (see ValidatePasswordResetTokenHandler's own docstring --
  // it never denies the token's jti), and the token already lives in the URL the emailed
  // link points at, so a query param is the natural fit rather than inventing a body for a
  // request that changes nothing.
  @Get("password-reset/validate")
  @HttpCode(HttpStatus.OK)
  async validatePasswordResetToken(@Query("token") token: string): Promise<PasswordResetValidateResponse> {
    return this.queryBus.execute(new ValidatePasswordResetTokenQuery(token));
  }

  @Post("password-reset/confirm")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UsePipes(new ZodValidationPipe(ResetPasswordRequestSchema))
  async confirmPasswordReset(@Body() body: ResetPasswordRequest): Promise<void> {
    await this.commandBus.execute(new ResetPasswordCommand(body.token, body.newPassword));
  }

  // 200 with real tokens, not 204: unlike password-reset/confirm (which sends the user back
  // to /login to prove 2FA again), this redeems a `changeToken` that only exists *after*
  // both factors already passed (see VerifyMfaHandler) -- there's a real session to hand
  // back, not just a "go log in now" instruction.
  @Post("password-change")
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(ChangePasswordRequestSchema))
  async changePassword(@Body() body: ChangePasswordRequest) {
    return this.commandBus.execute(new ChangePasswordCommand(body.changeToken, body.newPassword));
  }

  // GET, not POST: purely a read (see PreviewInvitationHandler's own docstring -- it never
  // denies the token's jti), and the token already lives in the URL the emailed link
  // points at, same reasoning as `password-reset/validate`.
  @Get("invitation")
  @HttpCode(HttpStatus.OK)
  async previewInvitation(@Query("token") token: string): Promise<InvitationPreview> {
    return this.queryBus.execute(new PreviewInvitationQuery(token));
  }

  @Post("activate")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UsePipes(new ZodValidationPipe(ActivateAccountRequestSchema))
  async activate(@Body() body: ActivateAccountRequest): Promise<void> {
    await this.commandBus.execute(new ActivateAccountCommand(body.token, body.newPassword));
  }

  // Authenticated -- unlike everything else above, which happens before a session exists.
  // See SwitchActiveClinicHandler's own docstring for what "active clinic" means.
  @Post("active-clinic")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async switchActiveClinic(
    @CurrentUser() claims: AccessTokenClaims,
    @Body(new ZodValidationPipe(SwitchActiveClinicRequestSchema)) body: SwitchActiveClinicRequest
  ): Promise<SwitchActiveClinicResult> {
    return this.commandBus.execute(new SwitchActiveClinicCommand(claims.sub, body.clinicTenantId, claims.clientOs));
  }

  @Get("me/clinics")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async myClinics(@CurrentUser() claims: AccessTokenClaims): Promise<MyClinic[]> {
    return this.queryBus.execute(new ListMyClinicsQuery(claims.sub, claims.homeTenantId ?? claims.tenantId, claims.tenantId));
  }

  // Self-scoped by construction (reads claims.sub, nothing else) -- no RolesGuard/@Roles at
  // all, deliberately: every authenticated role needs to be able to answer "who am I", most
  // immediately NURSING, which cannot call the admin-only GET /users/:id to find out its own
  // name/professional registration. See MeResponseSchema's own docstring.
  @Get("me")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() claims: AccessTokenClaims): Promise<MeResponse> {
    return this.queryBus.execute(new GetMeQuery(claims.sub));
  }
}
