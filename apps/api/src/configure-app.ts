import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import helmet from "helmet";

/**
 * Security-relevant middleware that has to be applied to the actual Express instance
 * (`app.use`/`app.enableCors`), not something `AppModule`'s own providers can declare --
 * extracted here so `main.ts`'s real bootstrap and `test/helpers.ts`'s `createTestApp()`
 * can never drift apart. Before this existed, the e2e test harness built via
 * `NestFactory.create(AppModule).init()` never went through `main.ts`'s `bootstrap()` at
 * all, so `helmet()`/CORS were silently absent from every "app" the test suite actually
 * exercised -- a real gap, not just a missing assertion: `test/security-headers.e2e.spec.ts`
 * only started passing once this got called from both places.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);
  app.use(helmet());
  app.enableCors({ origin: config.get<string>("CORS_ORIGIN"), credentials: true });
}
