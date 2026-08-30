import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.e2e.spec.ts"],
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/setup-env.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    // Each spec file boots its own full Nest application against the same test database.
    // Running files in parallel worker processes against shared Postgres state is exactly
    // the kind of flakiness that isn't worth debugging for an MVP's test suite -- every spec
    // uses randomly-suffixed emails/tenant names so it's safe, but sequential execution
    // keeps failures deterministic and easy to read.
    fileParallelism: false,
    // 'forks' (child processes), not the default 'threads': argon2's native addon has been
    // observed crashing the whole worker with a raw V8/Node abort when loaded inside a
    // worker_thread in this environment. Child processes don't share that constraint.
    pool: "forks",
  },
});
