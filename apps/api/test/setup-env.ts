/**
 * Runs once per test file, in the SAME process that file's tests execute in -- unlike
 * `globalSetup`, which vitest may run in a separate orchestrating context whose env changes
 * aren't guaranteed to propagate to worker processes. Since `AppModule`'s `ConfigModule`
 * reads `process.env` when `NestFactory.create()` actually instantiates it (not at import
 * time), setting these here before any test calls that is sufficient and safe.
 */
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://crop:crop_dev_password@localhost:5433/crop_test";
process.env.REDIS_URL = "redis://localhost:6379/1"; // separate DB index from dev (index 0)
process.env.JWT_ACCESS_SECRET = "test_access_secret_at_least_32_characters_long";
process.env.JWT_REFRESH_SECRET = "test_refresh_secret_at_least_32_characters_long";
process.env.CREDENTIALS_ENCRYPTION_KEY = "kzFMgvzjncroXXeyv5GJEnmamAmB8Uclfa4t6We7UZs="; // base64, exactly 32 bytes
process.env.CORS_ORIGIN = "http://localhost:5173";
process.env.PORT = "3999"; // unused -- tests call app.init(), never app.listen()
// Otherwise fires every 10s against these tests' deliberately-fake PiKVM hosts and "corrects"
// fixture equipment status mid-test-run -- see PiKvmHealthPoller's own comment on this flag.
process.env.DISABLE_HEALTH_POLLER = "true";
