export const MAILER = Symbol("MAILER");

/** A single outbound email. `text` is required (not derived from `html`) so a caller never
 * has to trust an HTML-to-text conversion for something as security-sensitive as a
 * password-reset link -- see `password-reset-email.ts`, the one caller today. */
export interface OutboundMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Sending an email is infrastructure, not an auth concern -- this port lives in `shared/`
 * so any future feature needing to send mail (there is exactly one today: password reset)
 * doesn't have to reach into `modules/iam` for it. Deliberately just `send`, not a whole
 * templating/queueing API: rendering the message is the caller's job (see
 * `password-reset-email.ts`), and there is no retry queue because a `RequestPasswordReset`
 * failure is not user-visible either way (see that handler's own docstring on why the
 * response can't depend on whether the send actually succeeded).
 */
export interface MailerPort {
  send(message: OutboundMail): Promise<void>;
}
