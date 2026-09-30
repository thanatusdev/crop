import type { OutboundMail } from "../../../shared/infrastructure/mail/mailer.port.js";

/**
 * Pure by design, same shape and reasoning as `password-reset-email.ts`: no I/O, no config
 * reads (`SendInvitationHandler` reads `APP_PUBLIC_URL` and passes the finished link in).
 * pt-BR copy, matching every other user-facing email in this app. Unlike a password-reset
 * request, sending this one is an *authenticated* admin action (see
 * `SendInvitationHandler`'s own docstring) -- there is no enumeration risk here, so this
 * email says outright that an account was created, which the reset email deliberately
 * never does.
 */
export function buildInvitationEmail(params: { to: string; activationLink: string; ttlHours: number; roleLabel: string }): OutboundMail {
  const { to, activationLink, ttlHours, roleLabel } = params;

  const text = [
    "Bem-vindo(a) ao RadLink",
    "",
    `Uma conta com o perfil "${roleLabel}" foi criada para você na plataforma RadLink.`,
    "",
    `Acesse o link abaixo para definir sua senha e ativar sua conta (válido por ${ttlHours} horas, uso único):`,
    activationLink,
    "",
    "Se você não esperava este e-mail, contate o administrador da sua clínica.",
  ].join("\n");

  const html = `
    <div style="font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#1f2733;">Bem-vindo(a) ao RadLink</h2>
      <p style="color:#1f2733;">Uma conta com o perfil <strong>${roleLabel}</strong> foi criada para você na plataforma RadLink.</p>
      <p style="text-align:center; margin: 24px 0;">
        <a href="${activationLink}" style="background:#0a6f83; color:#ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
          Ativar minha conta
        </a>
      </p>
      <p style="color:#5b6572; font-size: 13px;">
        Este link é de uso único e expira em ${ttlHours} horas. Se você não esperava este
        e-mail, contate o administrador da sua clínica.
      </p>
    </div>
  `.trim();

  return {
    to,
    subject: "RadLink -- Ative sua conta",
    html,
    text,
  };
}
