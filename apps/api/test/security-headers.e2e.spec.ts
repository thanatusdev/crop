import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers.js";

/**
 * Found via a verification pass explicitly asked for ("check if we're missing anything")
 * on top of a fully separate pass ("does the README match reality"): `helmet()` + scoped
 * CORS were documented in README.md/docs/architecture.md as "standard security headers,
 * strict CORS" -- true, but true-by-reading-`main.ts`-only. Nothing asserted on an actual
 * response before this. A future refactor that swapped `helmet()` for a no-op, or widened
 * `CORS_ORIGIN` to `*`, would have passed every existing test.
 */
describe("Security headers and CORS", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
  });

  it("sets helmet's default security headers on a real response", async () => {
    const res = await http.get("/metrics").expect(200);

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["x-dns-prefetch-control"]).toBe("off");
    expect(res.headers["x-download-options"]).toBe("noopen");
    expect(res.headers["x-permitted-cross-domain-policies"]).toBe("none");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["strict-transport-security"]).toContain("max-age=");
  });

  it("always returns the fixed configured CORS origin, never a wildcard, regardless of what Origin the request sends", async () => {
    // CORS_ORIGIN is set once (see test/setup-env.ts) to http://localhost:5173 -- a *static*
    // origin config, which is the safe pattern: Express's cors middleware echoes back this
    // exact configured value on every response, never the request's own Origin header. A
    // browser at localhost:5173 sees a match against its own origin and allows the read; a
    // browser at any other origin sees this same fixed value, which never matches *its own*
    // origin, so the browser's own same-origin enforcement blocks the read -- the server
    // doesn't need to (and structurally can't, with a static origin) selectively refuse.
    const sameOrigin = await http.get("/metrics").set("Origin", "http://localhost:5173").expect(200);
    expect(sameOrigin.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(sameOrigin.headers["access-control-allow-credentials"]).toBe("true");

    const otherOrigin = await http.get("/metrics").set("Origin", "http://evil.example.com").expect(200);
    // Not absent, and NOT reflecting the attacker's origin either -- always the one
    // configured value. This is what makes the config "strict": there is no code path that
    // could ever echo back an arbitrary incoming Origin.
    expect(otherOrigin.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(otherOrigin.headers["access-control-allow-origin"]).not.toBe("*");
    expect(otherOrigin.headers["access-control-allow-origin"]).not.toBe("http://evil.example.com");
  });
});
