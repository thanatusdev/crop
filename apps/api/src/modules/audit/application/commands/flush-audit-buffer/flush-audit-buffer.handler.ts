import { Inject, Logger } from "@nestjs/common";
import { CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { MetricsService } from "../../../../../shared/infrastructure/metrics/metrics.service.js";
import { AUDIT_BUFFER, type AuditBufferPort } from "../../ports/audit-buffer.port.js";
import { AUDIT_REPOSITORY, type AuditRepositoryPort } from "../../ports/audit-repository.port.js";
import type { AuditEvent } from "../../../domain/audit-event.js";
import { FlushAuditBufferCommand } from "./flush-audit-buffer.command.js";

/**
 * Drains every session's Redis input buffer into one Postgres row per session (not one row
 * per event -- see docs/architecture.md), batched into a single transaction per tenant.
 *
 * Runs in a single process for this MVP (see SessionRuntimePort's docstring for the same
 * scaling note): a second replica running this same cron would double-flush. A production
 * deployment adds a Redis lock (SET NX EX) around this method; deliberately omitted here
 * because building distributed-lock infrastructure for a single-instance deployment is
 * exactly the kind of speculative generality YAGNI warns against.
 */
@CommandHandler(FlushAuditBufferCommand)
export class FlushAuditBufferHandler implements ICommandHandler<FlushAuditBufferCommand, void> {
  private readonly logger = new Logger(FlushAuditBufferHandler.name);

  constructor(
    @Inject(AUDIT_BUFFER) private readonly buffer: AuditBufferPort,
    @Inject(AUDIT_REPOSITORY) private readonly repository: AuditRepositoryPort,
    private readonly metrics: MetricsService
  ) {}

  async execute(): Promise<void> {
    const startedAt = performance.now();
    try {
      await this.doFlush();
    } finally {
      this.metrics.auditFlushDurationSeconds.observe((performance.now() - startedAt) / 1000);
    }
  }

  private async doFlush(): Promise<void> {
    const sessionIds = await this.buffer.listBufferedSessionIds();
    this.metrics.auditFlushBatchSize.observe(sessionIds.length);
    if (sessionIds.length === 0) return;

    const eventsByTenant = new Map<string, AuditEvent[]>();

    for (const sessionId of sessionIds) {
      const items = await this.buffer.claimAndClear(sessionId);
      if (items.length === 0) continue;

      const tenantId = items[0]!.tenantId;
      const event: AuditEvent = {
        tenantId,
        userId: null, // multiple users may have contributed input within one flush window (e.g. around a takeover)
        sessionId,
        action: AuditAction.INPUT_BATCH,
        resourceType: "Session",
        resourceId: sessionId,
        details: { events: items.map(({ userId, event }) => ({ userId, event })) },
      };

      const bucket = eventsByTenant.get(tenantId) ?? [];
      bucket.push(event);
      eventsByTenant.set(tenantId, bucket);
    }

    for (const [tenantId, events] of eventsByTenant) {
      try {
        await this.repository.appendBatch(tenantId, events);
      } catch (err) {
        // Buffered input is already claimed (removed from Redis) at this point. Losing a
        // batch here loses input-history audit detail for that window, but never a critical
        // event (those are synchronous) and never leaves data in an inconsistent half-written
        // state, since appendBatch is one transaction.
        this.logger.error(`Failed to flush audit batch for tenant ${tenantId}: ${(err as Error).message}`);
      }
    }
  }
}
