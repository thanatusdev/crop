import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { MailerPort, OutboundMail } from "./mailer.port.js";

/**
 * Dev and test adapter, used whenever `MAILER_DRIVER=file` (the default -- see
 * env.validation.ts). Appends one JSON line per message to `MAIL_OUTBOX_PATH`, rather than
 * holding messages in a module-level array: `apps/api/test/helpers.ts` already documents a
 * real dual-module-instance hazard (the e2e suite imports the *compiled* `dist/app.module.js`,
 * so an in-memory array inside the running app is not the same object a test file importing
 * this class would see) -- going through the filesystem sidesteps that entirely, the same way
 * SnapshotStorageService sidesteps object-storage until there's a real reason to add it.
 *
 * This is also what makes `make demo` genuinely usable end-to-end with no real email
 * provider configured: a developer can just open the outbox file and click the link, instead
 * of the flow silently going nowhere.
 */
@Injectable()
export class FileOutboxMailer implements MailerPort {
  private readonly logger = new Logger(FileOutboxMailer.name);
  private readonly path: string;

  constructor(config: ConfigService) {
    this.path = resolve(config.get<string>("MAIL_OUTBOX_PATH", "./storage/mail-outbox.jsonl"));
  }

  async send(message: OutboundMail): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const line = JSON.stringify({ ...message, sentAt: new Date().toISOString() });
    await appendFile(this.path, line + "\n", "utf8");
    this.logger.log(`Mail (file outbox) -> ${message.to}: ${message.subject}`);
  }
}
