import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { EquipmentStatus } from "@crop/shared";
import { PiKvmRestClient } from "@crop/pikvm";
import { GetEquipmentConnectionSecretsQuery } from "../application/queries/get-equipment-credentials/get-equipment-connection-secrets.query.js";
import { UpdateEquipmentStatusCommand } from "../application/commands/update-equipment-status/update-equipment-status.command.js";
import { EQUIPMENT_REPOSITORY, type EquipmentRepositoryPort } from "../application/ports/equipment-repository.port.js";

/**
 * Polls every registered PiKVM's `/api/info` on a fixed interval and reflects the result as
 * Equipment.status. This is what makes "MRI-01 online" on the dashboard mean something
 * real, rather than a value nobody ever updates after equipment creation.
 */
@Injectable()
export class PiKvmHealthPoller {
  private readonly logger = new Logger(PiKvmHealthPoller.name);

  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly equipmentRepo: EquipmentRepositoryPort,
    private readonly queryBus: QueryBus,
    private readonly commandBus: CommandBus,
    private readonly config: ConfigService
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async pollAll(): Promise<void> {
    // The e2e suite (test/*.e2e.spec.ts) deliberately sets equipment status directly as a
    // fixture, against hosts that are never meant to actually respond -- this poller
    // legitimately running against those every 10s and "correcting" that fixture mid-test
    // is a real background-scheduler-vs-test-fixture race, not a poller bug. Disabled only
    // in that one environment; every other environment, including local dev, is unaffected.
    if (this.config.get<boolean>("DISABLE_HEALTH_POLLER", false)) return;

    const equipment = await this.equipmentRepo.listAll();
    // Equipment manually parked in MAINTENANCE (EnterMaintenanceHandler) is deliberately
    // skipped here -- without this, the very next poll cycle (at most 10s later) would
    // silently revert a manual override back to ONLINE/OFFLINE/DEGRADED, making the feature
    // pointless. Only ClearMaintenanceHandler is allowed to move equipment out of
    // MAINTENANCE; see its own comment for what it reverts to and why.
    const pollable = equipment.filter((item) => !item.isInMaintenance());
    await Promise.all(pollable.map((item) => this.pollOne(item.id)));
  }

  private async pollOne(equipmentId: string): Promise<void> {
    try {
      const secrets = await this.queryBus.execute(new GetEquipmentConnectionSecretsQuery(equipmentId));
      const client = new PiKvmRestClient(secrets);
      const info = await client.getInfo();
      const status = info.hid?.online ? EquipmentStatus.ONLINE : EquipmentStatus.DEGRADED;
      await this.commandBus.execute(new UpdateEquipmentStatusCommand(equipmentId, status));
    } catch (err) {
      this.logger.warn(`Health check failed for equipment ${equipmentId}: ${(err as Error).message}`);
      await this.commandBus.execute(new UpdateEquipmentStatusCommand(equipmentId, EquipmentStatus.OFFLINE));
    }
  }
}
