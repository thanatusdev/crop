import { Controller, Get, Header } from "@nestjs/common";
import { MetricsService } from "./metrics.service.js";

/**
 * Deliberately unauthenticated, matching near-universal Prometheus convention: the scrape
 * endpoint is protected by network placement (only the Prometheus server's network segment
 * can reach it), not by application-level auth, since Prometheus's own scrape config has no
 * standard way to carry a JWT that would fit this platform's auth model. Production
 * deployments must not expose this endpoint publicly -- see docs/architecture.md.
 */
@Controller("metrics")
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async getMetrics(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
