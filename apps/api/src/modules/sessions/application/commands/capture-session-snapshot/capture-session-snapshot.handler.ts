import { Inject, Logger } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommandHandler } from "@nestjs/cqrs";
import { AuditAction } from "@crop/shared";
import { MetricsService } from "../../../../../shared/infrastructure/metrics/metrics.service.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { PIKVM_GATEWAY, type PiKvmGatewayPort } from "../../ports/pikvm-gateway.port.js";
import { SNAPSHOT_STORAGE, type SnapshotStoragePort } from "../../ports/snapshot-storage.port.js";
import {
  SESSION_SNAPSHOT_REPOSITORY,
  type SessionSnapshotRepositoryPort,
} from "../../ports/session-snapshot-repository.port.js";
import { CaptureSessionSnapshotCommand } from "./capture-session-snapshot.command.js";

/**
 * Turns the audit trail from "coordinates" into "what the operator could actually see at
 * time T" -- see docs/architecture.md. Triggered periodically by SnapshotCaptureScheduler
 * for every active session; a failure here (device unreachable, snapshot empty) is logged
 * and skipped, never thrown, so one bad capture never interrupts the session itself.
 */
@CommandHandler(CaptureSessionSnapshotCommand)
export class CaptureSessionSnapshotHandler implements ICommandHandler<CaptureSessionSnapshotCommand, void> {
  private readonly logger = new Logger(CaptureSessionSnapshotHandler.name);

  constructor(
    @Inject(PIKVM_GATEWAY) private readonly pikvm: PiKvmGatewayPort,
    @Inject(SNAPSHOT_STORAGE) private readonly storage: SnapshotStoragePort,
    @Inject(SESSION_SNAPSHOT_REPOSITORY) private readonly snapshots: SessionSnapshotRepositoryPort,
    private readonly commandBus: CommandBus,
    private readonly metrics: MetricsService
  ) {}

  async execute(command: CaptureSessionSnapshotCommand): Promise<void> {
    const startedAt = performance.now();
    try {
      await this.capture(command);
    } finally {
      this.metrics.snapshotCaptureDurationSeconds.observe((performance.now() - startedAt) / 1000);
    }
  }

  private async capture(command: CaptureSessionSnapshotCommand): Promise<void> {
    const jpeg = await this.pikvm.captureSnapshot(command.equipmentId);
    if (!jpeg || jpeg.length === 0) {
      this.logger.warn(`Snapshot capture skipped for session ${command.sessionId}: no image available`);
      return;
    }

    const imagePath = await this.storage.save(command.sessionId, jpeg);
    await this.snapshots.create({ sessionId: command.sessionId, imagePath });

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: command.tenantId,
        userId: null, // system-triggered, not a user action
        sessionId: command.sessionId,
        action: AuditAction.SNAPSHOT_CAPTURED,
        resourceType: "Session",
        resourceId: command.sessionId,
        details: { imagePath, sizeBytes: jpeg.length },
      })
    );
  }
}
