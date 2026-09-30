import { Injectable } from "@nestjs/common";
import { computeAuditHash, type AuditLogEntryDto, type HashChainInput } from "@crop/shared";
import { PrismaService } from "../../../shared/infrastructure/prisma/prisma.service.js";
import type { AuditEvent } from "../domain/audit-event.js";
import type { AuditRepositoryPort, ChainRow, ListAuditLogsFilter } from "../application/ports/audit-repository.port.js";

@Injectable()
export class PrismaAuditRepository implements AuditRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async appendCritical(event: AuditEvent): Promise<void> {
    await this.appendBatch(event.tenantId, [event]);
  }

  async appendBatch(tenantId: string, events: AuditEvent[]): Promise<void> {
    if (events.length === 0) return;

    await this.prisma.$transaction(async (tx) => {
      // Postgres advisory lock, scoped to this transaction, keyed by tenant: serializes
      // concurrent writers for the SAME tenant (so seq/prevHash reads-then-writes below can't
      // race) while never blocking writes for a different tenant.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`;

      const last = await tx.auditLog.findFirst({
        where: { tenantId },
        orderBy: { seq: "desc" },
        select: { seq: true, hash: true },
      });

      let seq = last?.seq ?? 0;
      let prevHash: string | null = last?.hash ?? null;

      for (const event of events) {
        seq += 1;
        const timestamp = new Date();
        const input: HashChainInput = {
          tenantId,
          seq,
          timestamp: timestamp.toISOString(),
          userId: event.userId,
          action: event.action,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          details: event.details,
          prevHash,
        };
        const hash = await computeAuditHash(input);

        await tx.auditLog.create({
          data: {
            tenantId,
            seq,
            timestamp,
            userId: event.userId,
            sessionId: event.sessionId,
            action: event.action,
            resourceType: event.resourceType,
            resourceId: event.resourceId,
            ip: event.ip ?? null,
            userAgent: event.userAgent ?? null,
            details: event.details as object,
            hash,
            prevHash,
          },
        });

        prevHash = hash;
      }
    });
  }

  async list(filter: ListAuditLogsFilter): Promise<AuditLogEntryDto[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        tenantId: filter.tenantId,
        sessionId: filter.sessionId,
        userId: filter.userId,
        resourceType: filter.resourceType,
        resourceId: filter.resourceId,
      },
      orderBy: { seq: "desc" },
      take: filter.limit,
      skip: filter.offset,
    });

    return rows.map((row) => ({
      id: row.id,
      seq: row.seq,
      tenantId: row.tenantId,
      userId: row.userId,
      sessionId: row.sessionId,
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      details: row.details,
      hash: row.hash,
      prevHash: row.prevHash,
      timestamp: row.timestamp.toISOString(),
    }));
  }

  async loadChain(tenantId: string): Promise<ChainRow[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { tenantId },
      orderBy: { seq: "asc" },
    });

    return rows.map((row) => ({
      input: {
        tenantId: row.tenantId,
        seq: row.seq,
        timestamp: row.timestamp.toISOString(),
        userId: row.userId,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        details: row.details,
        prevHash: row.prevHash,
      },
      hash: row.hash,
    }));
  }
}
