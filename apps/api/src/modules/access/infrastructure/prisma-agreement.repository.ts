import { Injectable } from "@nestjs/common";
import { AgreementStatus } from "@crop/shared";
import { ForbiddenError, ValidationError } from "../../../shared/domain/errors.js";
import { PrismaService } from "../../../shared/infrastructure/prisma/prisma.service.js";
import { OperatorAgreement } from "../domain/operator-agreement.entity.js";
import type {
  AgreementRepositoryPort,
  AgreementScopeTarget,
  CreateAgreementData,
  ResolvedScopeTarget,
} from "../application/ports/agreement-repository.port.js";

/** The `include` every read here uses -- scopes are part of the aggregate, never lazily fetched:
 * the caller's question is almost always "does this agreement cover X", which is unanswerable
 * without them. */
const WITH_SCOPES = { scopes: true } as const;

interface AgreementRow {
  id: string;
  clinicTenantId: string;
  operatorTenantId: string;
  // `string`, not the enum: Prisma generates a string-union type while @crop/shared exports a
  // nominal TS enum, and the two are not mutually assignable. Cast once in `toDomain`, exactly
  // as PrismaQueueRepository already does for QueueStatus.
  status: string;
  proposedByTenantId: string;
  proposedByUserId: string | null;
  respondedByUserId: string | null;
  respondedAt: Date | null;
  revokedByUserId: string | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  scopes: { id: string; unitId: string | null; equipmentId: string | null }[];
}

@Injectable()
export class PrismaAgreementRepository implements AgreementRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<OperatorAgreement | null> {
    const row = await this.prisma.operatorAgreement.findUnique({ where: { id }, include: WITH_SCOPES });
    return row ? this.toDomain(row) : null;
  }

  async findByPair(clinicTenantId: string, operatorTenantId: string): Promise<OperatorAgreement | null> {
    const row = await this.prisma.operatorAgreement.findUnique({
      where: { clinicTenantId_operatorTenantId: { clinicTenantId, operatorTenantId } },
      include: WITH_SCOPES,
    });
    return row ? this.toDomain(row) : null;
  }

  async listForTenant(tenantId: string, status?: AgreementStatus): Promise<OperatorAgreement[]> {
    const rows = await this.prisma.operatorAgreement.findMany({
      where: {
        OR: [{ clinicTenantId: tenantId }, { operatorTenantId: tenantId }],
        ...(status ? { status } : {}),
      },
      include: WITH_SCOPES,
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => this.toDomain(row));
  }

  async listActiveClinicIdsForOperator(operatorTenantId: string): Promise<string[]> {
    const rows = await this.prisma.operatorAgreement.findMany({
      where: { operatorTenantId, status: AgreementStatus.ACTIVE },
      select: { clinicTenantId: true },
    });
    return rows.map((row) => row.clinicTenantId);
  }

  async findActiveForOperatorInClinic(operatorTenantId: string, clinicTenantId: string): Promise<OperatorAgreement | null> {
    const row = await this.prisma.operatorAgreement.findFirst({
      where: { operatorTenantId, clinicTenantId, status: AgreementStatus.ACTIVE },
      include: WITH_SCOPES,
    });
    return row ? this.toDomain(row) : null;
  }

  async create(data: CreateAgreementData): Promise<OperatorAgreement> {
    const row = await this.prisma.operatorAgreement.create({
      data: {
        clinicTenantId: data.clinicTenantId,
        operatorTenantId: data.operatorTenantId,
        status: AgreementStatus.PENDING,
        proposedByTenantId: data.proposedByTenantId,
        proposedByUserId: data.proposedByUserId ?? undefined,
      },
      include: WITH_SCOPES,
    });
    return this.toDomain(row);
  }

  async recordResponse(id: string, status: AgreementStatus, respondedByUserId: string | null): Promise<OperatorAgreement> {
    const row = await this.prisma.operatorAgreement.update({
      where: { id },
      data: { status, respondedByUserId: respondedByUserId ?? undefined, respondedAt: new Date() },
      include: WITH_SCOPES,
    });
    return this.toDomain(row);
  }

  async revoke(id: string, revokedByUserId: string | null): Promise<OperatorAgreement> {
    const row = await this.prisma.operatorAgreement.update({
      where: { id },
      data: { status: AgreementStatus.REVOKED, revokedByUserId: revokedByUserId ?? undefined, revokedAt: new Date() },
      include: WITH_SCOPES,
    });
    return this.toDomain(row);
  }

  async reopenAsPending(id: string, proposedByTenantId: string, proposedByUserId: string | null): Promise<OperatorAgreement> {
    const row = await this.prisma.operatorAgreement.update({
      where: { id },
      data: {
        status: AgreementStatus.PENDING,
        proposedByTenantId,
        proposedByUserId: proposedByUserId ?? undefined,
        // Cleared, not kept: these describe the answer to the *previous* proposal, and leaving
        // them in place would make a freshly-reopened agreement look like it had already been
        // answered. The history of the old round lives in `audit_logs`.
        respondedByUserId: null,
        respondedAt: null,
        revokedByUserId: null,
        revokedAt: null,
      },
      include: WITH_SCOPES,
    });
    return this.toDomain(row);
  }

  /**
   * Replaces scope in a transaction, after proving every target belongs to `clinicTenantId`.
   *
   * That ownership check is the security-critical part and it lives here, at the write boundary,
   * rather than only in the handler: this table *is* the authorization data, so a row naming
   * another clinic's equipment would be a cross-tenant escalation persisted as a grant. Done
   * inside the transaction so a unit that is deleted or reassigned concurrently cannot slip
   * through between validation and insert.
   */
  async replaceScope(id: string, clinicTenantId: string, targets: AgreementScopeTarget[]): Promise<OperatorAgreement> {
    const unitIds = targets.map((t) => t.unitId).filter((v): v is string => !!v);
    const equipmentIds = targets.map((t) => t.equipmentId).filter((v): v is string => !!v);

    if (new Set(unitIds).size !== unitIds.length || new Set(equipmentIds).size !== equipmentIds.length) {
      throw new ValidationError("Duplicate unit or equipment in agreement scope");
    }

    const row = await this.prisma.$transaction(async (tx) => {
      if (unitIds.length > 0) {
        const owned = await tx.unit.count({ where: { id: { in: unitIds }, clinicTenantId } });
        if (owned !== unitIds.length) {
          throw new ForbiddenError("Every unit in an agreement's scope must belong to that agreement's clinic");
        }
      }
      if (equipmentIds.length > 0) {
        const owned = await tx.equipment.count({ where: { id: { in: equipmentIds }, tenantId: clinicTenantId } });
        if (owned !== equipmentIds.length) {
          throw new ForbiddenError("Every equipment in an agreement's scope must belong to that agreement's clinic");
        }
      }

      await tx.operatorAgreementScope.deleteMany({ where: { agreementId: id } });
      if (targets.length > 0) {
        await tx.operatorAgreementScope.createMany({
          data: targets.map((target) => ({
            agreementId: id,
            unitId: target.unitId ?? null,
            equipmentId: target.equipmentId ?? null,
          })),
        });
      }
      return tx.operatorAgreement.findUniqueOrThrow({ where: { id }, include: WITH_SCOPES });
    });

    return this.toDomain(row);
  }

  /**
   * Resolves scope rows to display labels. Reads `unit`/`equipment` through Prisma directly
   * rather than through their own repositories, the same one-directional choice
   * `PrismaUnitRepository` already documents for its equipment/room aggregation: going through
   * UnitsModule/EquipmentModule would make those modules depend on this one and this one on them,
   * and the cycle buys nothing -- these are two name lookups, not domain behaviour.
   */
  async resolveScopeTargets(agreementId: string): Promise<ResolvedScopeTarget[]> {
    const scopes = await this.prisma.operatorAgreementScope.findMany({
      where: { agreementId },
      include: {
        unit: { select: { name: true } },
        equipment: { select: { name: true, modality: true, roomLabel: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    return scopes.map((scope) => ({
      id: scope.id,
      unitId: scope.unitId,
      equipmentId: scope.equipmentId,
      label: scope.unit
        ? scope.unit.name
        : scope.equipment
          ? [scope.equipment.name, scope.equipment.roomLabel].filter(Boolean).join(" • ")
          : // A scope row whose target row is gone. Not reachable today (both FKs cascade on
            // delete), but rendering an empty string would be a silent hole in a screen whose
            // whole job is showing what an outside company can reach.
            "(alvo removido)",
      modality: scope.equipment?.modality ?? null,
    }));
  }

  async tenantNames(tenantIds: string[]): Promise<Record<string, string>> {
    if (tenantIds.length === 0) return {};
    const rows = await this.prisma.tenant.findMany({
      where: { id: { in: [...new Set(tenantIds)] } },
      select: { id: true, name: true },
    });
    return Object.fromEntries(rows.map((row) => [row.id, row.name]));
  }

  async findEquipmentForScopeCheck(equipmentId: string): Promise<{ id: string; tenantId: string; unitId: string | null } | null> {
    return this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { id: true, tenantId: true, unitId: true },
    });
  }

  async resolveEquipmentUnitIds(equipmentIds: string[]): Promise<Map<string, string | null>> {
    if (equipmentIds.length === 0) return new Map();
    const rows = await this.prisma.equipment.findMany({
      where: { id: { in: equipmentIds } },
      select: { id: true, unitId: true },
    });
    return new Map(rows.map((row) => [row.id, row.unitId]));
  }

  private toDomain(row: AgreementRow): OperatorAgreement {
    return new OperatorAgreement({
      id: row.id,
      clinicTenantId: row.clinicTenantId,
      operatorTenantId: row.operatorTenantId,
      status: row.status as AgreementStatus,
      proposedByTenantId: row.proposedByTenantId,
      proposedByUserId: row.proposedByUserId,
      respondedByUserId: row.respondedByUserId,
      respondedAt: row.respondedAt,
      revokedByUserId: row.revokedByUserId,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      scopes: row.scopes.map((scope) => ({ id: scope.id, unitId: scope.unitId, equipmentId: scope.equipmentId })),
    });
  }
}
