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
  SESSION_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(600000),
  IDLE_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  // Deliberately not `z.coerce.boolean()`: that coerces ANY non-empty string, including the
  // literal text "false", to `true` (it's just `Boolean(str)` under the hood) -- a classic
  // env-var footgun. An explicit string enum is the correct way to parse a boolean env var.
  DISABLE_HEALTH_POLLER: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = EnvSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  return result.data;
}
