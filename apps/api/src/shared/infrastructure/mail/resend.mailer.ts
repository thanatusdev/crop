import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Resend } from "resend";
import type { MailerPort, OutboundMail } from "./mailer.port.js";

/**
 * Production adapter. `RESEND_API_KEY`/`MAIL_FROM` are only read (and required) when
 * `MAILER_DRIVER=resend` -- see `mail.module.ts`'s factory, which is the only place this
 * class is ever constructed, and `env.validation.ts`'s own comment on why they aren't
 * unconditionally required at boot.
 */
@Injectable()
export class ResendMailer implements MailerPort {
  private readonly logger = new Logger(ResendMailer.name);
  private readonly client: Resend;
  private readonly from: string;

  constructor(config: ConfigService) {
    this.client = new Resend(config.getOrThrow<string>("RESEND_API_KEY"));
    this.from = config.getOrThrow<string>("MAIL_FROM");
  }

  async send(message: OutboundMail): Promise<void> {
    const { error } = await this.client.emails.send({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    if (error) {
      // Never thrown back to an HTTP caller -- see RequestPasswordResetHandler's docstring:
      // a send failure must not change the response, or it becomes an email-enumeration
      // signal. Logged loudly here instead, which is the only place this failure is still
      // visible to anyone (an operator watching logs/alerts), not to the requester.
      this.logger.error(`Resend send to ${message.to} failed: ${error.message}`);
      throw new Error(`Resend send failed: ${error.message}`);
    }
  }
}
