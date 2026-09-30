import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MAILER, type MailerPort } from "./mailer.port.js";
import { ResendMailer } from "./resend.mailer.js";
import { FileOutboxMailer } from "./file-outbox.mailer.js";

/**
 * Picks the `MailerPort` implementation from `MAILER_DRIVER` (an explicit enum, not inferred
 * from whether `RESEND_API_KEY` happens to be set -- same "never silently coerce, always an
 * explicit switch" reasoning `DISABLE_HEALTH_POLLER` documents in env.validation.ts).
 *
 * The chosen adapter is constructed by hand inside the factory (`new ResendMailer(...)`),
 * not registered as its own Nest provider: Nest instantiates every registered provider
 * eagerly at bootstrap regardless of whether anything ends up using it, and
 * `ResendMailer`'s constructor calls `config.getOrThrow("RESEND_API_KEY")` -- if it were a
 * provider, every `MAILER_DRIVER=file` boot (every dev machine and the entire e2e/a11y
 * suite, none of which set a Resend key) would fail at startup for a class the app never
 * actually asked for.
 */
@Module({
  providers: [
    {
      provide: MAILER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): MailerPort =>
        config.get<string>("MAILER_DRIVER", "file") === "resend" ? new ResendMailer(config) : new FileOutboxMailer(config),
    },
  ],
  exports: [MAILER],
})
export class MailModule {}
