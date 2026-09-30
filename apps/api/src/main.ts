import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module.js";
import { configureApp } from "./configure-app.js";
import { PinoLoggerService } from "./shared/infrastructure/logging/pino-logger.service.js";

async function bootstrap(): Promise<void> {
  // Constructed directly (it has no DI dependencies) and passed in at `create()`, not
  // attached later via `app.useLogger()`: that would miss every log Nest itself emits
  // during module initialization ("AppModule dependencies initialized", etc.), which is
  // exactly the noisy startup phase worth having in the same structured format as everything
  // else, not console text nobody's log aggregator can parse.
  const logger = new PinoLoggerService();
  const app = await NestFactory.create(AppModule, { logger });
  const config = app.get(ConfigService);

  configureApp(app);

  const port = config.get<number>("PORT", 3000);
  await app.listen(port);
  logger.log(`RadLink API listening on :${port}`, "Bootstrap");
}

bootstrap();
