import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, EventBus, QueryBus, type ICommandHandler } from "@nestjs/cqrs";
import { ConfigService } from "@nestjs/config";
import { AuditAction } from "@crop/shared";
import { ConflictError, ForbiddenError } from "../../../../../shared/domain/errors.js";
import { MetricsService } from "../../../../../shared/infrastructure/metrics/metrics.service.js";
import { GetEquipmentQuery } from "../../../../equipment/application/queries/get-equipment/get-equipment.query.js";
import { GetEquipmentConnectionSecretsQuery } from "../../../../equipment/application/queries/get-equipment-credentials/get-equipment-connection-secrets.query.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
import { QueueUpdatedEvent } from "../../../../queue/application/events/queue-updated.event.js";
import { UNIT_REPOSITORY, type UnitRepositoryPort } from "../../../../units/application/ports/unit-repository.port.js";
import { Session } from "../../../domain/session.entity.js";
import { PIKVM_GATEWAY, type PiKvmGatewayPort } from "../../ports/pikvm-gateway.port.js";
import { SESSION_REPOSITORY, type SessionRepositoryPort } from "../../ports/session-repository.port.js";
import { SESSION_RUNTIME, type SessionRuntimePort } from "../../ports/session-runtime.port.js";
import { StartSessionCommand } from "./start-session.command.js";

@CommandHandler(StartSessionCommand)
export class StartSessionHandler implements ICommandHandler<StartSessionCommand, Session> {
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
    @Inject(PIKVM_GATEWAY) private readonly pikvm: PiKvmGatewayPort,
    @Inject(SESSION_RUNTIME) private readonly runtime: SessionRuntimePort,
    @Inject(UNIT_REPOSITORY) private readonly units: UnitRepositoryPort,
    private readonly queryBus: QueryBus,
    private readonly commandBus: CommandBus,
    private readonly eventBus: EventBus,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService
  ) {}

  async execute(command: StartSessionCommand): Promise<Session> {
    const equipment = await this.queryBus.execute(new GetEquipmentQuery(command.equipmentId, command.tenantId, command.actor));
    // Was `equipment.status !== EquipmentStatus.ONLINE` inline here. Now delegated to the
    // domain predicate, which additionally rejects equipment an admin has retired
    // (`deactivatedAt`) -- a case this inline check silently allowed: the health poller skips
    // deactivated equipment, so a scanner retired while healthy keeps its frozen `ONLINE`
    // status forever and would have passed a status-only check indefinitely.
    if (!equipment.isAvailableForSession()) {
      throw new ConflictError(
        equipment.isDeactivated() ? `O equipamento ${equipment.name} foi desativado.` : `O equipamento ${equipment.name} não está online.`
      );
    }

    // The unit cascade: retiring a *unit* (SetUnitDeactivatedHandler) does not touch its
    // equipment's own `deactivatedAt` at all -- a device keeps its independent retirement
    // flag, and reactivating the unit later must not silently un-retire equipment someone
    // retired for an unrelated reason in between (see that handler's own docstring). So the
    // unit has to be checked here, separately, rather than folded into
    // `equipment.isAvailableForSession()`, which has no knowledge of units at all -- unlike
    // `Equipment`, which owns its own `deactivatedAt`, a unit is a different aggregate this
    // handler already reaches into (`UNIT_REPOSITORY`), not something the equipment entity
    // could check about itself. `equipment.unitId` is only ever null for a handful of rows
    // that predate units entirely (see schema.prisma's own comment); nothing to check then.
    if (equipment.unitId) {
      const unit = await this.units.findById(equipment.unitId);
      if (unit?.isDeactivated()) {
        throw new ConflictError(`A unidade do equipamento ${equipment.name} foi desativada.`);
      }
    }

    // Fast-path, friendly-error check for the common case. This alone has a TOCTOU race
    // under true concurrency (two requests could both pass this before either commits its
    // INSERT) -- the actual correctness guarantee is the partial unique index in
    // `sessions_one_active_per_equipment` (prisma/migrations/*_one_active_session_per_equipment),
    // which PrismaSessionRepository.create() translates back into this same ConflictError if
    // the race is ever actually hit.
    const existingSession = await this.sessions.findActiveByEquipment(command.equipmentId);
    if (existingSession) {
      throw new ConflictError(`O equipamento ${equipment.name} já possui uma sessão ativa.`);
    }

    const maxConcurrent = this.config.get<number>("MAX_CONCURRENT_SESSIONS_PER_OPERATOR", 3);
    const activeCount = await this.sessions.countActiveByOperator(command.operatorId);
    if (activeCount >= maxConcurrent) {
      throw new ForbiddenError(`Você já possui ${maxConcurrent} sessões ativas, o limite permitido.`);
    }

    const secrets = await this.queryBus.execute(new GetEquipmentConnectionSecretsQuery(command.equipmentId));
    await this.pikvm.acquire(command.equipmentId, secrets);

    const session = await this.sessions.create({
      equipmentId: command.equipmentId,
      operatorId: command.operatorId,
      queueEntryId: command.queueEntryId,
    });

    // `sessions.create` also moved the queue entry to IN_PROGRESS, in the same transaction
    // (see SessionRepositoryPort.create) -- without that, the dashboard's "next waiting
    // patient" picker kept re-selecting an already-consumed entry, and `queueEntryId` is
    // `@unique` on sessions, so that always collided. Tell connected clients it happened
    // (see EndSessionHandler's identical event): otherwise the dashboard's queue table and
    // the nursing lock banner only showed IN_PROGRESS after a manual reload.
    if (command.queueEntryId) {
      this.eventBus.publish(new QueueUpdatedEvent(command.tenantId, command.equipmentId));
    }

    this.runtime.setController(session.id, command.operatorId);
    this.runtime.recordActivity(session.id); // idle-timeout clock starts now, not at "undefined"
    this.metrics.sessionsActive.inc();

    await this.commandBus.execute(
      new RecordAuditEventCommand({
        tenantId: command.tenantId,
        userId: command.operatorId,
        sessionId: session.id,
        action: AuditAction.SESSION_START,
        resourceType: "Equipment",
        resourceId: command.equipmentId,
        details: { queueEntryId: command.queueEntryId },
      })
    );

    return session;
  }
}
