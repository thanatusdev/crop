import { z } from "zod";

/**
 * Validated once at boot. A missing or malformed env var fails fast with a clear message
 * instead of surfacing as a confusing runtime error three requests into the demo.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  // Read directly from `process.env` in main.ts's `PinoLoggerService` construction, not via
  // `ConfigService` -- that logger is deliberately built before `NestFactory.create()` even
  // runs (see its own comment), which is before `validateEnv` below ever executes. Declared
  // here anyway for documentation, and because this schema doubles as this project's one
  // canonical list of every env var this app looks at, even the handful (this one, and
  // `CORS_ORIGIN` inside SessionsGateway) that can't actually be read through it.
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(604800),
  CREDENTIALS_ENCRYPTION_KEY: z.string().min(1),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  AUDIT_FLUSH_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  MAX_CONCURRENT_SESSIONS_PER_OPERATOR: z.coerce.number().int().positive().default(3),
  MEDIA_STREAM_TICKET_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  SNAPSHOT_STORAGE_DIR: z.string().default("./storage/snapshots"),
  SNAPSHOT_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  // Local disk, same MVP scope decision as SNAPSHOT_STORAGE_DIR above (see
  // ChatAttachmentStorageService's own docstring for why, and DEPLOY.md's "Known
  // limitations" for the redeploy caveat that follows from it). A separate directory, not a
  // subfolder of SNAPSHOT_STORAGE_DIR, so the two features' retention/cleanup policies can
  // diverge later without one accidentally sweeping the other's files.
  CHAT_ATTACHMENT_STORAGE_DIR: z.string().default("./storage/chat-attachments"),
  // 10 MiB: generous enough for a phone photo of a wristband or a signed PDF requisition,
  // small enough that one attachment can't meaningfully strain the same local disk
  // SNAPSHOT_STORAGE_DIR already writes to. Enforced by ChatController's FileInterceptor
  // config, not by Zod -- Multer needs a plain number of bytes at interceptor-construction
  // time, before ConfigService (and therefore this validated value) exists; see that
  // controller's own comment for the same "can't inject ConfigService here" constraint
  // SessionsGateway's CORS_ORIGIN fallback already documents.
  CHAT_ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  // The nurse's uploaded exam-order documents (pedido médico / laudo anterior) -- same
  // volume-backed-local-disk reasoning as the two directories above, its own subdirectory.
  QUEUE_DOCUMENT_STORAGE_DIR: z.string().default("./storage/queue-documents"),
  // 20 MiB: a scanned multi-page order run through a phone's camera-to-PDF app runs bigger
  // than a chat photo. Same "enforced by FileInterceptor config, not Zod, so a plain number
  // is needed before ConfigService exists" constraint as CHAT_ATTACHMENT_MAX_BYTES above.
  QUEUE_DOCUMENT_MAX_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  SESSION_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(600000),
  IDLE_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  // Deliberately not `z.coerce.boolean()`: that coerces ANY non-empty string, including the
  // literal text "false", to `true` (it's just `Boolean(str)` under the hood) -- a classic
  // env-var footgun. An explicit string enum is the correct way to parse a boolean env var.
  DISABLE_HEALTH_POLLER: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Same "explicit enum, not inferred from whether a key happens to be set" reasoning as
  // DISABLE_HEALTH_POLLER above -- see shared/infrastructure/mail/mail.module.ts. Defaults
  // to the adapter that needs no external account at all, so a fresh clone of this repo can
  // run the full password-reset flow (`make demo`, the e2e suite) with zero mail setup.
  MAILER_DRIVER: z.enum(["resend", "file"]).default("file"),
  // Required only when MAILER_DRIVER=resend (ResendMailer's own constructor enforces that
  // via getOrThrow, not this schema -- see mail.module.ts's docstring on why it can't be
  // required here without breaking every MAILER_DRIVER=file boot).
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default("RadLink <no-reply@radlink.med.br>"),
  MAIL_OUTBOX_PATH: z.string().default("./storage/mail-outbox.jsonl"),
  // The frontend's own origin, for building links that appear in emails (password reset).
  // Deliberately separate from CORS_ORIGIN even though both default to the same value:
  // CORS_ORIGIN is a security policy (who may call this API from a browser); this is a
  // link-building base (where the frontend actually lives). They happen to coincide in
  // dev/single-origin deploys, but conflating them would break the moment they diverge --
  // e.g. this repo's own live demo, where the API is on Railway and the frontend on Netlify.
  APP_PUBLIC_URL: z.string().default("http://localhost:5173"),
  PASSWORD_RESET_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  // Password policy, history, and rotation -- see packages/shared/src/password-policy.ts and
  // docs/architecture.md. PASSWORD_MAX_AGE_DAYS: 0 disables expiry entirely (see
  // User.isPasswordExpired's own comment) -- not a magic negative number, an explicit floor
  // check, so "off" can never be typo'd into "expires immediately".
  PASSWORD_HISTORY_DEPTH: z.coerce.number().int().min(1).default(5),
  PASSWORD_MAX_AGE_DAYS: z.coerce.number().int().min(0).default(90),
  PASSWORD_CHANGE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  // How long an "Enviar Convite Seguro" activation link stays redeemable -- default 24h,
  // matching the admin-facing copy that promises exactly that. See JwtTokenService.
  INVITE_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  // The one timezone "today" means for the nursing day-view's "N Pacientes Hoje" query and
  // its own scheduled-time display -- see packages/shared/src/clinic-day.ts, the single
  // source of truth both this value and apps/web's own (hardcoded, since a browser has no
  // server env to read) default agree on. Not validated against the IANA database here --
  // Node's own Intl throws a clear RangeError at first use if it's ever misconfigured,
  // which is the same "fail loud at the boundary that actually knows" this schema already
  // leaves to other runtime checks (e.g. CREDENTIALS_ENCRYPTION_KEY's real length
  // requirement is enforced by the crypto call that uses it, not by a regex here).
  CLINIC_TIME_ZONE: z.string().min(1).default("America/Sao_Paulo"),
});

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = EnvSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  return result.data;
}
