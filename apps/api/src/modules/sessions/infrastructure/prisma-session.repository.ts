import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { SessionStatus } from "@crop/shared";
import { PrismaService } from "../../../shared/infrastructure/prisma/prisma.service.js";
import { ConflictError } from "../../../shared/domain/errors.js";
import { Session } from "../domain/session.entity.js";
import type { CreateSessionData, SessionRepositoryPort } from "../application/ports/session-repository.port.js";

const WITH_TENANT = { equipment: { select: { tenantId: true } } } as const;

@Injectable()
export class PrismaSessionRepository implements SessionRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateSessionData): Promise<Session> {
    try {
      const row = await this.prisma.session.create({
        data: {
          equipmentId: data.equipmentId,
          operatorId: data.operatorId,
          controllerUserId: data.operatorId,
          queueEntryId: data.queueEntryId,
          status: SessionStatus.ACTIVE,
          startedAt: new Date(),
        },
        include: WITH_TENANT,
      });
      return this.toDomain(row);
    } catch (err) {
      // P2002 here can only be the partial unique index in
      // `sessions_one_active_per_equipment` -- this table has no other unique constraint.
      // Translates the rare TOCTOU race (see StartSessionHandler's comment) into the same
      // domain error the fast-path check already throws for the common case.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ConflictError("Equipment already has an active session");
      }
      throw err;
    }
  }

  async findById(id: string): Promise<Session | null> {
    const row = await this.prisma.session.findUnique({ where: { id }, include: WITH_TENANT });
    return row ? this.toDomain(row) : null;
  }

  async findActiveByEquipment(equipmentId: string): Promise<Session | null> {
    const row = await this.prisma.session.findFirst({
      where: { equipmentId, status: { in: [SessionStatus.PENDING, SessionStatus.ACTIVE] } },
      include: WITH_TENANT,
    });
    return row ? this.toDomain(row) : null;
  }

  async listActiveByTenant(tenantId: string): Promise<Session[]> {
    const rows = await this.prisma.session.findMany({
      where: {
        status: { in: [SessionStatus.PENDING, SessionStatus.ACTIVE] },
        equipment: { tenantId },
      },
      include: WITH_TENANT,
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => this.toDomain(row));
  }

  async listAllActive(): Promise<Session[]> {
    const rows = await this.prisma.session.findMany({
      where: { status: { in: [SessionStatus.PENDING, SessionStatus.ACTIVE] } },
      include: WITH_TENANT,
    });
    return rows.map((row) => this.toDomain(row));
  }

  async countActiveByOperator(operatorId: string): Promise<number> {
    return this.prisma.session.count({
      where: { operatorId, status: { in: [SessionStatus.PENDING, SessionStatus.ACTIVE] } },
    });
  }

  async setController(
    sessionId: string,
    controllerUserId: string,
    supervisorId: string | null,
    expectedCurrentControllerUserId: string
  ): Promise<boolean> {
    // `updateMany`, not `update`: `update` takes a unique-field `where` and always either
    // applies or throws `RecordNotFound` -- it has no way to express "only if this other
    // column still has this value", which is exactly the compare-and-swap this needs.
    // `updateMany`'s `where` clause has no such restriction, and its `count` tells us
    // whether the condition actually held at the moment Postgres evaluated it.
    const result = await this.prisma.session.updateMany({
      where: { id: sessionId, controllerUserId: expectedCurrentControllerUserId },
      data: { controllerUserId, supervisorId },
    });
    return result.count === 1;
  }

  async end(sessionId: string, status: "ENDED" | "ABORTED"): Promise<void> {
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { status, endedAt: new Date() },
    });
  }

  private toDomain(row: {
    id: string;
    equipmentId: string;
    equipment: { tenantId: string };
    operatorId: string;
    supervisorId: string | null;
    controllerUserId: string;
    status: string;
    startedAt: Date | null;
    endedAt: Date | null;
  }): Session {
    return new Session({
      id: row.id,
      tenantId: row.equipment.tenantId,
      equipmentId: row.equipmentId,
      operatorId: row.operatorId,
      supervisorId: row.supervisorId,
      controllerUserId: row.controllerUserId,
      status: row.status as SessionStatus,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
    });
  }
}
