import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers.js";

/**
 * JwtAuthGuard is global: every HTTP route requires an access token unless it is marked
 * `@Public()`. This sweeps every route the app registers rather than a hand-kept list, so a
 * new controller that forgets authentication fails here instead of shipping open.
 */
const PUBLIC_ROUTES = new Set([
  "GET /metrics",
  "POST /auth/login",
  "POST /auth/mfa/verify",
  "POST /auth/mfa/enroll/confirm",
  "POST /auth/refresh",
  "POST /auth/logout",
  "POST /auth/password-reset/request",
  "GET /auth/password-reset/validate",
  "POST /auth/password-reset/confirm",
  "POST /auth/password-change",
  "GET /auth/invitation",
  "POST /auth/activate",
]);

interface ExpressLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

describe("Authentication by default", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let routes: Array<{ method: string; path: string }>;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    const express = app.getHttpAdapter().getInstance();
    const stack: ExpressLayer[] = (express.router ?? express._router).stack;
    routes = stack
      .filter((layer) => layer.route)
      .flatMap((layer) =>
        Object.keys(layer.route!.methods).map((method) => ({ method: method.toUpperCase(), path: layer.route!.path }))
      );
  });

  afterAll(async () => {
    await app.close();
  });

  it("finds the app's routes (sanity check for the sweep below)", () => {
    expect(routes.length).toBeGreaterThan(50);
    for (const key of PUBLIC_ROUTES) {
      expect(routes.some((r) => `${r.method} ${r.path}` === key)).toBe(true);
    }
  });

  it("rejects every non-public route without a token", async () => {
    const open: string[] = [];
    for (const { method, path } of routes) {
      const key = `${method} ${path}`;
      if (PUBLIC_ROUTES.has(key)) continue;
      const url = path.replace(/:[A-Za-z]+/g, "00000000-0000-0000-0000-000000000000");
      const res = await http[method.toLowerCase() as "get" | "post" | "patch" | "put" | "delete"](url);
      if (res.status !== 401) open.push(`${key} -> ${res.status}`);
    }
    expect(open).toEqual([]);
  });

  it("keeps the public routes reachable without a token", async () => {
    await http.get("/metrics").expect(200);
    // Answers "ok" for any address (no account enumeration), so it is a clean 200 here.
    await http.post("/auth/password-reset/request").send({ email: `nobody-${crypto.randomUUID()}@test.crop.health` }).expect(200);
  });
});
