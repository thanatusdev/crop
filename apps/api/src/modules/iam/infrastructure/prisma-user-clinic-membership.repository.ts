import { Injectable } from "@nestjs/common";
import type { UserRole } from "@crop/shared";
import { PrismaService } from "../../../shared/infrastructure/prisma/prisma.service.js";
import type { UserClinicMembershipRepositoryPort } from "../application/ports/user-clinic-membership.port.js";

@Injectable()
export class PrismaUserClinicMembershipRepository implements UserClinicMembershipRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async grant(userId: string, clinicTenantIds: readonly string[]): Promise<void> {
    if (clinicTenantIds.length === 0) return;
    // `skipDuplicates`: registration always includes the user's own home tenant in this
    // list (see RegisterUserHandler), which the migration backfill or a prior grant could
    // already have inserted -- this stays idempotent rather than throwing on the unique
    // constraint.
    await this.prisma.userClinicMembership.createMany({
      data: clinicTenantIds.map((clinicTenantId) => ({ userId, clinicTenantId })),
      skipDuplicates: true,
    });
  }

  async listClinicIdsForUser(userId: string): Promise<string[]> {
    const rows = await this.prisma.userClinicMembership.findMany({ where: { userId }, select: { clinicTenantId: true } });
    return rows.map((row) => row.clinicTenantId);
  }

  async listClinicIdsForUsers(userIds: readonly string[]): Promise<Record<string, string[]>> {
    const result: Record<string, string[]> = {};
    for (const userId of userIds) result[userId] = [];
    if (userIds.length === 0) return result;

    const rows = await this.prisma.userClinicMembership.findMany({
      where: { userId: { in: [...userIds] } },
      select: { userId: true, clinicTenantId: true },
    });
    for (const row of rows) {
      result[row.userId]!.push(row.clinicTenantId);
    }
    return result;
  }

  async isMember(userId: string, clinicTenantId: string): Promise<boolean> {
    const row = await this.prisma.userClinicMembership.findUnique({
      where: { userId_clinicTenantId: { userId, clinicTenantId } },
    });
    return row !== null;
  }

  async hasMemberWithRole(clinicTenantId: string, role: string): Promise<boolean> {
    // Joins through the membership table, not `user.tenantId` directly: a CLINIC_ADMIN's
    // *home* tenant is just their default active clinic (see AccessTokenClaims) -- rule 1
    // lets a Manager be linked to several clinics, so a clinic where they're a
    // non-home member must still count as "having a Manager" for rule 2's purposes.
    const count = await this.prisma.userClinicMembership.count({
      where: { clinicTenantId, user: { role: role as UserRole } },
    });
    return count > 0;
  }
}
