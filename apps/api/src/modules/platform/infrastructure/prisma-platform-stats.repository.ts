import { Injectable } from "@nestjs/common";
import type { PlatformStatsDto } from "@crop/shared";
import { PrismaService } from "../../../shared/infrastructure/prisma/prisma.service.js";
import type { PlatformStatsRepositoryPort } from "../application/ports/platform-stats-repository.port.js";

const ACTIVE_USER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class PrismaPlatformStatsRepository implements PlatformStatsRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async getStats(now: Date): Promise<PlatformStatsDto> {
    const activeSince = new Date(now.getTime() - ACTIVE_USER_WINDOW_MS);
    const [
      usersTotal,
      usersActive,
      clinicsActive,
      clinicsDeactivated,
      operatorsActive,
      operatorsDeactivated,
      equipmentTotal,
      equipmentOnline,
      sessionsActive,
      agreementsActive,
      agreementsPending,
    ] = await this.prisma.$transaction([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { lastLoginAt: { gte: activeSince } } }),
      this.prisma.tenant.count({ where: { type: "CLINIC", deactivatedAt: null } }),
      this.prisma.tenant.count({ where: { type: "CLINIC", deactivatedAt: { not: null } } }),
      this.prisma.tenant.count({ where: { type: "OPERATOR_PROVIDER", deactivatedAt: null } }),
      this.prisma.tenant.count({ where: { type: "OPERATOR_PROVIDER", deactivatedAt: { not: null } } }),
      this.prisma.equipment.count({ where: { deactivatedAt: null } }),
      this.prisma.equipment.count({ where: { deactivatedAt: null, status: "ONLINE" } }),
      this.prisma.session.count({ where: { status: "ACTIVE" } }),
      this.prisma.operatorAgreement.count({ where: { status: "ACTIVE" } }),
      this.prisma.operatorAgreement.count({ where: { status: "PENDING" } }),
    ]);

    return {
      users: { total: usersTotal, activeLast30Days: usersActive },
      clinics: { active: clinicsActive, deactivated: clinicsDeactivated },
      operators: { active: operatorsActive, deactivated: operatorsDeactivated },
      equipment: { total: equipmentTotal, online: equipmentOnline },
      sessions: { active: sessionsActive },
      agreements: { active: agreementsActive, pending: agreementsPending },
    };
  }
}
