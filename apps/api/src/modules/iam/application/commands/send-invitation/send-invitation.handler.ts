import { Inject, Logger } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { ConfigService } from "@nestjs/config";
import { AuditAction, UserRole } from "@crop/shared";
import { ConflictError, ForbiddenError, NotFoundError } from "../../../../../shared/domain/errors.js";
import { MAILER, type MailerPort } from "../../../../../shared/infrastructure/mail/mailer.port.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { TOKEN_SERVICE, type TokenServicePort } from "../../ports/token-service.port.js";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../ports/user-repository.port.js";
import { buildInvitationEmail } from "../../../infrastructure/invitation-email.js";
import { SendInvitationCommand } from "./send-invitation.command.js";

/** pt-BR labels for the invitation email's body -- deliberately duplicated from the
 * frontend's `roles` i18n namespace rather than shared, since the API has no i18n layer of
 * its own and this is the one place it renders role-facing prose. */
const ROLE_LABELS_PT_BR: Record<UserRole, string> = {
  [UserRole.PLATFORM_ADMIN]: "Administrador da Plataforma",
  [UserRole.CLINIC_ADMIN]: "Gestor de Clínica",
  [UserRole.LOCAL_SUPERVISOR]: "Supervisor",
  [UserRole.NURSING]: "Enfermagem",
  [UserRole.LOCAL_IT]: "TI Local",
  [UserRole.OPERATOR_ADMIN]: "Administrador da Operadora",
  [UserRole.OPERATIONAL_SUPERVISOR]: "Supervisor Operacional",
  [UserRole.OPERATOR]: "Operador Biomédico",
  [UserRole.AUDITOR]: "Auditor",
};

/**
 * Sends (or resends) the "Enviar Convite Seguro" activation link -- the replacement for an
 * admin typing a temp password directly (see `CreateUserRequestSchema`'s own docstring).
 * Unlike `RequestPasswordResetHandler`, this is always an *authenticated* admin action
 * (there is no public "invite myself" endpoint), so there is no email-enumeration risk to
 * defend against: the send is awaited and a failure is surfaced to the caller as a real
 * error, not silently swallowed.
 */
@CommandHandler(SendInvitationCommand)
export class SendInvitationHandler implements ICommandHandler<SendInvitationCommand, void> {
  private readonly logger = new Logger(SendInvitationHandler.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenServicePort,
    @Inject(MAILER) private readonly mailer: MailerPort,
    private readonly config: ConfigService,
    private readonly commandBus: CommandBus
  ) {}

  async execute(command: SendInvitationCommand): Promise<void> {
    const user = await this.users.findById(command.userId);
    if (!user) throw new NotFoundError("User", command.userId);

    // Same tenant-isolation pattern as LockUserHandler -- skipped only when this is called
    // internally, right after RegisterUserCommand, where there is nothing to isolate
    // against (the caller just created this exact user in this exact tenant).
    if (command.actingAdminTenantId && !user.belongsToTenant(command.actingAdminTenantId)) {
      throw new ForbiddenError("User does not belong to your tenant");
    }

    if (user.isActivated()) {
      throw new ConflictError("This account has already been activated");
    }

    const token = this.tokens.signInvitation(user.id);
    const ttlSeconds = this.config.get<number>("INVITE_TTL_SECONDS", 86400);
    const appUrl = this.config.get<string>("APP_PUBLIC_URL", "http://localhost:5173");
    const activationLink = `${appUrl}/ativar-conta?token=${token}`;

    const message = buildInvitationEmail({
      to: user.email,
      activationLink,
      ttlHours: Math.round(ttlSeconds / 3600),
      roleLabel: ROLE_LABELS_PT_BR[user.role],
    });

    // Awaited, unlike RequestPasswordResetHandler's fire-and-forget -- see class docstring.
    try {
      await this.mailer.send(message);
    } catch (err) {
      this.logger.error(`Failed to send invitation email to ${user.email}: ${(err as Error).message}`);
      throw err;
    }

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: user.tenantId,
        userId: command.actingAdminId,
        sessionId: null,
        action: command.isResend ? AuditAction.USER_INVITE_RESENT : AuditAction.USER_INVITED,
        resourceType: "User",
        resourceId: user.id,
        details: { email: user.email },
      })
    );
  }
}
