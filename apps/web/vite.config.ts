import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  // `@crop/shared` compiles to CommonJS (see packages/shared -- its package.json has no
  // "type": "module", so `tsc`'s NodeNext output defaults to CJS, which apps/api's own
  // CommonJS build consumes via plain `require()` with no issue). Vite's dependency
  // optimizer normally CJS->ESM-interops third-party CommonJS packages automatically, but
  // pnpm workspace packages resolved via a symlink are served raw through `/@fs/` instead,
  // bypassing that conversion -- the browser then gets literal `exports.X = ...` CommonJS
  // source fed to a native ESM `import`, which has no named exports at all from a browser's
  // perspective ("does not provide an export named 'TargetOs'"). Forcing it into
  // `optimizeDeps` makes esbuild pre-bundle (and correctly interop) it like any other CJS
  // dependency. Confirmed necessary by actually loading the app in a real browser -- see
  // docs/architecture.md.
  optimizeDeps: {
    include: ["@crop/shared"],
  },
});
