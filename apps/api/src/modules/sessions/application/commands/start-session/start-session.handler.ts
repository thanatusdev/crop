import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, QueryBus, type ICommandHandler } from "@nestjs/cqrs";
import { ConfigService } from "@nestjs/config";
import { AuditAction, EquipmentStatus } from "@crop/shared";
import { ConflictError, ForbiddenError } from "../../../../../shared/domain/errors.js";
import { MetricsService } from "../../../../../shared/infrastructure/metrics/metrics.service.js";
import { GetEquipmentQuery } from "../../../../equipment/application/queries/get-equipment/get-equipment.query.js";
import { GetEquipmentConnectionSecretsQuery } from "../../../../equipment/application/queries/get-equipment-credentials/get-equipment-connection-secrets.query.js";
import { RecordAuditEventCommand } from "../../../../audit/application/commands/record-audit-event/record-audit-event.command.js";
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
    private readonly queryBus: QueryBus,
    private readonly commandBus: CommandBus,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService
  ) {}

  async execute(command: StartSessionCommand): Promise<Session> {
    const equipment = await this.queryBus.execute(new GetEquipmentQuery(command.equipmentId, command.tenantId));
    if (equipment.status !== EquipmentStatus.ONLINE) {
      throw new ConflictError(`Equipment ${equipment.name} is not online`);
    }

    // Fast-path, friendly-error check for the common case. This alone has a TOCTOU race
    // under true concurrency (two requests could both pass this before either commits its
    // INSERT) -- the actual correctness guarantee is the partial unique index in
    // `sessions_one_active_per_equipment` (prisma/migrations/*_one_active_session_per_equipment),
    // which PrismaSessionRepository.create() translates back into this same ConflictError if
    // the race is ever actually hit.
    const existingSession = await this.sessions.findActiveByEquipment(command.equipmentId);
    if (existingSession) {
      throw new ConflictError(`Equipment ${equipment.name} already has an active session`);
    }

    const maxConcurrent = this.config.get<number>("MAX_CONCURRENT_SESSIONS_PER_OPERATOR", 3);
    const activeCount = await this.sessions.countActiveByOperator(command.operatorId);
    if (activeCount >= maxConcurrent) {
      throw new ForbiddenError(`Operator already has ${maxConcurrent} active sessions`);
    }

    const secrets = await this.queryBus.execute(new GetEquipmentConnectionSecretsQuery(command.equipmentId));
    await this.pikvm.acquire(command.equipmentId, secrets);

    const session = await this.sessions.create({
      equipmentId: command.equipmentId,
      operatorId: command.operatorId,
      queueEntryId: command.queueEntryId,
    });

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
