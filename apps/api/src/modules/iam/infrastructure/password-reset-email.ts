import type { OutboundMail } from "../../../shared/infrastructure/mail/mailer.port.js";

/**
 * Pure by design: no I/O, no config reads, so it's testable as plain data-in/data-out
 * (`RequestPasswordResetHandler` reads `APP_PUBLIC_URL` and passes the finished link in).
 * pt-BR copy, matching the login/recovery screens -- this is the one email this app sends,
 * and those are the only two pages currently translated (see docs/architecture.md).
 */
export function buildPasswordResetEmail(params: { to: string; resetLink: string; ttlMinutes: number }): OutboundMail {
  const { to, resetLink, ttlMinutes } = params;

  const text = [
    "Solicitação de redefinição de senha",
    "",
    "Recebemos uma solicitação para redefinir a senha da sua conta RadLink.",
    "",
    `Acesse o link abaixo para definir uma nova senha (válido por ${ttlMinutes} minutos, uso único):`,
    resetLink,
    "",
    "Se você não fez essa solicitação, ignore este e-mail -- sua senha atual continua válida.",
  ].join("\n");

  const html = `
    <div style="font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#1f2733;">Solicitação de redefinição de senha</h2>
      <p style="color:#1f2733;">Recebemos uma solicitação para redefinir a senha da sua conta RadLink.</p>
      <p style="text-align:center; margin: 24px 0;">
        <a href="${resetLink}" style="background:#0a6f83; color:#ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
          Redefinir senha
        </a>
      </p>
      <p style="color:#5b6572; font-size: 13px;">
        Este link é de uso único e expira em ${ttlMinutes} minutos. Se você não fez essa
        solicitação, ignore este e-mail -- sua senha atual continua válida.
      </p>
    </div>
  `.trim();

  return {
    to,
    subject: "RadLink -- Redefinição de senha",
    html,
    text,
  };
}
