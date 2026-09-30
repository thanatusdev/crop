import { Inject, Logger } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { ConfigService } from "@nestjs/config";
import { AuditAction } from "@crop/shared";
import { TooManyRequestsError } from "../../../../../shared/domain/errors.js";
import { MAILER, type MailerPort } from "../../../../../shared/infrastructure/mail/mailer.port.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { RATE_LIMITER, type RateLimiterPort } from "../../ports/rate-limiter.port.js";
import { TOKEN_SERVICE, type TokenServicePort } from "../../ports/token-service.port.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { TENANT_REPOSITORY, type TenantRepositoryPort } from "../../../../tenants/application/ports/tenant-repository.port.js";
import { buildPasswordResetEmail } from "../../../infrastructure/password-reset-email.js";
import { RequestPasswordResetCommand } from "./request-password-reset.command.js";

const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 60 * 60;

/**
 * Reverses a previously deliberate decision (see docs/architecture.md and
 * AdminResetPasswordHandler's own docstring): this codebase now has a mailer
 * (shared/infrastructure/mail), so self-service reset is possible without the
 * enumeration/spam risks that used to make "just add SMTP" the wrong call on its own.
 *
 * The response is IDENTICAL whether or not `email` belongs to a real, unlocked account in
 * an active tenant -- always the same success, always after the same rate-limit check, with
 * no timing difference an attacker could use to enumerate valid emails:
 *   - The email send is fired but never awaited (`void this.mailer.send(...)`, wrapped so a
 *     rejection can't become an unhandled rejection): awaiting it would make response time
 *     depend on whether a real send actually happened, which is itself a timing oracle. A
 *     send failure is only ever visible in logs, never to the caller.
 *   - An unknown email, a locked account, and a deactivated tenant all fall through to the
 *     same "do nothing further, but still return success" path -- silently, unlike
 *     LoginHandler's lock/deactivation checks, which surface a specific error because a
 *     *known* legitimate user typing their own correct password deserves to know why they're
 *     stuck. Here, the caller typed an email into a public, pre-auth form; telling them
 *     "this account is locked" would be telling a possible attacker that too.
 *   - PASSWORD_RESET_REQUESTED is only ever audited when a real user was found -- same
 *     reasoning LoginHandler documents for LOGIN_FAILURE on an unknown email: there's no
 *     tenantId to attribute a row to otherwise.
 */
@CommandHandler(RequestPasswordResetCommand)
export class RequestPasswordResetHandler implements ICommandHandler<RequestPasswordResetCommand, void> {
  private readonly logger = new Logger(RequestPasswordResetHandler.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepositoryPort,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenServicePort,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiterPort,
    @Inject(MAILER) private readonly mailer: MailerPort,
    private readonly config: ConfigService,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: RequestPasswordResetCommand): Promise<void> {
    // Keyed by email, same reasoning as LoginHandler's own limiter: this throws regardless
    // of whether the account exists, so the 429 itself leaks nothing about existence -- an
    // attacker hammering a fake email sees the exact same rate limit as a real one.
    const rateLimitKey = `ratelimit:pwreset-request:${command.email.toLowerCase()}`;
    const { allowed } = await this.rateLimiter.checkAndIncrement(rateLimitKey, MAX_ATTEMPTS, WINDOW_SECONDS);
    if (!allowed) {
      this.logger.warn(`Rate limit exceeded for password reset requests against ${command.email}`);
      throw new TooManyRequestsError("Too many password reset requests. Try again later.");
    }

    const user = await this.users.findByEmail(command.email);
    if (!user) return; // see class docstring -- silently a no-op, still a "success" to the caller

    if (user.isLocked()) return;
    // An unactivated account (see RegisterUserHandler) has its own dedicated onboarding
    // link (SendInvitationHandler) -- a password-reset link would just be a second,
    // redundant way to set its first password, and issuing one here would leak "this email
    // has an account" the exact same way a locked/deactivated account's silence exists to
    // prevent (see class docstring).
    if (!user.isActivated()) return;

    const tenant = await this.tenants.findById(user.tenantId);
    if (tenant?.isDeactivated()) return;

    const token = this.tokens.signPasswordReset(user.id);
    const ttlSeconds = this.config.get<number>("PASSWORD_RESET_TTL_SECONDS", 900);
    const appUrl = this.config.get<string>("APP_PUBLIC_URL", "http://localhost:5173");
    const resetLink = `${appUrl}/recuperar-senha?token=${token}`;

    const message = buildPasswordResetEmail({ to: user.email, resetLink, ttlMinutes: Math.round(ttlSeconds / 60) });
    // Deliberately not awaited -- see class docstring. `.catch` (not a bare fire-and-forget)
    // so a send failure becomes a logged fact, not an unhandled promise rejection that could
    // crash the process depending on Node's config.
    void this.mailer.send(message).catch((err: unknown) => {
      this.logger.error(`Failed to send password reset email to ${user.email}: ${(err as Error).message}`);
    });

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: user.tenantId,
        userId: user.id,
        sessionId: null,
        action: AuditAction.PASSWORD_RESET_REQUESTED,
        resourceType: "User",
        resourceId: user.id,
        details: {},
      })
    );
  }
}
