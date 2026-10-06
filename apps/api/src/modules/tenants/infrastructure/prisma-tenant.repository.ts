import { Injectable } from "@nestjs/common";
import type { ExamModality, ResponsibleManagerOption, TenantType, UserRole } from "@crop/shared";
import { PrismaService } from "../../../shared/infrastructure/prisma/prisma.service.js";
import { Tenant } from "../domain/tenant.entity.js";
import type {
  ClinicSummary,
  CreateTenantData,
  OperatorSummary,
  ResponsibleManagerCandidate,
  ResponsibleManagerSummary,
  TenantRepositoryPort,
  UpdateTenantData,
} from "../application/ports/tenant-repository.port.js";

@Injectable()
export class PrismaTenantRepository implements TenantRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateTenantData): Promise<Tenant> {
    const row = await this.prisma.tenant.create({
      data: {
        name: data.name,
        type: data.type,
        cnpj: data.cnpj ?? undefined,
        institutionalEmail: data.institutionalEmail ?? undefined,
        phone: data.phone ?? undefined,
        zipCode: data.zipCode ?? undefined,
        street: data.street ?? undefined,
        number: data.number ?? undefined,
        complement: data.complement ?? undefined,
        district: data.district ?? undefined,
        city: data.city ?? undefined,
        state: data.state ?? undefined,
      },
    });
    return this.toDomain(row);
  }

  async findById(id: string): Promise<Tenant | null> {
    const row = await this.prisma.tenant.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async findByCnpj(cnpj: string): Promise<Tenant | null> {
    const row = await this.prisma.tenant.findUnique({ where: { cnpj } });
    return row ? this.toDomain(row) : null;
  }

  async findByResponsibleManagerId(userId: string): Promise<Tenant | null> {
    const row = await this.prisma.tenant.findFirst({ where: { responsibleManagerId: userId } });
    return row ? this.toDomain(row) : null;
  }

  async listAll(filter?: { type?: TenantType }): Promise<Tenant[]> {
    const rows = await this.prisma.tenant.findMany({ where: filter?.type ? { type: filter.type } : undefined, orderBy: { name: "asc" } });
    return rows.map((row) => this.toDomain(row));
  }

  async update(id: string, data: UpdateTenantData): Promise<Tenant> {
    const row = await this.prisma.tenant.update({ where: { id }, data });
    return this.toDomain(row);
  }

  async deactivate(id: string): Promise<void> {
    await this.prisma.tenant.update({ where: { id }, data: { deactivatedAt: new Date() } });
  }

  async reactivate(id: string): Promise<void> {
    await this.prisma.tenant.update({ where: { id }, data: { deactivatedAt: null } });
  }

  async summarizeClinics(tenantIds: string[]): Promise<Record<string, ClinicSummary>> {
    const summaries: Record<string, ClinicSummary> = {};
    if (tenantIds.length === 0) return summaries;
    for (const tenantId of tenantIds) summaries[tenantId] = { equipmentCount: 0, unitCount: 0, modalities: [] };

    // `equipmentCount`: every row, retired or not -- a decommissioned scanner is still
    // equipment that was linked here, the same inventory reasoning
    // `UnitRepositoryPort.summarizeEquipment`'s own `equipmentCount` already uses.
    const equipmentCounts = await this.prisma.equipment.groupBy({
      by: ["tenantId"],
      where: { tenantId: { in: tenantIds } },
      _count: { _all: true },
    });
    for (const row of equipmentCounts) {
      summaries[row.tenantId]!.equipmentCount = row._count._all;
    }

    // `unitCount`: same reasoning, every unit regardless of its own `deactivatedAt`.
    const unitCounts = await this.prisma.unit.groupBy({
      by: ["clinicTenantId"],
      where: { clinicTenantId: { in: tenantIds } },
      _count: { _all: true },
    });
    for (const row of unitCounts) {
      if (summaries[row.clinicTenantId]) summaries[row.clinicTenantId]!.unitCount = row._count._all;
    }

    // `modalities`: distinct values among only *non-retired* equipment -- what's actually
    // installed today, not the clinic's full equipment history. `groupBy` counts rows, not
    // distinct values as a set per tenant, so this is a plain `findMany` + in-memory Set,
    // the same shape `UnitRepositoryPort.summarizeEquipment`'s own `roomCount` already uses.
    const modalityRows = await this.prisma.equipment.findMany({
      where: { tenantId: { in: tenantIds }, deactivatedAt: null, modality: { not: null } },
      select: { tenantId: true, modality: true },
      distinct: ["tenantId", "modality"],
    });
    for (const row of modalityRows) {
      if (row.modality) summaries[row.tenantId]?.modalities.push(row.modality as ExamModality);
    }

    return summaries;
  }

  async summarizeOperators(tenantIds: string[]): Promise<Record<string, OperatorSummary>> {
    const summaries: Record<string, OperatorSummary> = {};
    if (tenantIds.length === 0) return summaries;
    for (const tenantId of tenantIds) summaries[tenantId] = { activeAgreementCount: 0, userCount: 0 };

    // ACTIVE agreements naming this tenant on either side -- a CLINIC and an
    // OPERATOR_PROVIDER are each a party the same way, so both relations are counted and
    // merged rather than picking one based on this tenant's own type.
    const [asClinic, asOperator, userCounts] = await Promise.all([
      this.prisma.operatorAgreement.groupBy({
        by: ["clinicTenantId"],
        where: { clinicTenantId: { in: tenantIds }, status: "ACTIVE" },
        _count: { _all: true },
      }),
      this.prisma.operatorAgreement.groupBy({
        by: ["operatorTenantId"],
        where: { operatorTenantId: { in: tenantIds }, status: "ACTIVE" },
        _count: { _all: true },
      }),
      this.prisma.user.groupBy({
        by: ["tenantId"],
        where: { tenantId: { in: tenantIds } },
        _count: { _all: true },
      }),
    ]);
    for (const row of asClinic) summaries[row.clinicTenantId]!.activeAgreementCount += row._count._all;
    for (const row of asOperator) summaries[row.operatorTenantId]!.activeAgreementCount += row._count._all;
    for (const row of userCounts) if (summaries[row.tenantId]) summaries[row.tenantId]!.userCount = row._count._all;

    return summaries;
  }

  async summarizeResponsibleManagers(userIds: string[]): Promise<Record<string, ResponsibleManagerSummary>> {
    const summaries: Record<string, ResponsibleManagerSummary> = {};
    if (userIds.length === 0) return summaries;
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, firstName: true, lastName: true, email: true, professionalRegistration: true },
    });
    for (const user of users) {
      // Same email-local-part fallback the equivalent unit-side lookup already uses (and
      // `packages/shared/src/password-policy.ts` before that) when firstName/lastName are
      // null -- historical accounts predate those columns.
      const full = [user.firstName, user.lastName].filter((part): part is string => !!part).join(" ");
      summaries[user.id] = {
        id: user.id,
        name: full.length > 0 ? full : user.email.split("@")[0]!,
        professionalRegistration: user.professionalRegistration,
      };
    }
    return summaries;
  }

  async findResponsibleManagerCandidate(userId: string): Promise<ResponsibleManagerCandidate | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, tenantId: true, role: true, activatedAt: true, lockedAt: true },
    });
    if (!user) return null;
    return { id: user.id, tenantId: user.tenantId, role: user.role as UserRole, activatedAt: user.activatedAt, lockedAt: user.lockedAt };
  }

  async listResponsibleManagerOptions(tenantId: string, role: UserRole): Promise<ResponsibleManagerOption[]> {
    const users = await this.prisma.user.findMany({
      where: { tenantId, role, activatedAt: { not: null }, lockedAt: null },
      select: { id: true, firstName: true, lastName: true, email: true, role: true, professionalRegistration: true },
    });
    return users.map((user) => {
      const full = [user.firstName, user.lastName].filter((part): part is string => !!part).join(" ");
      return {
        id: user.id,
        name: full.length > 0 ? full : user.email.split("@")[0]!,
        email: user.email,
        role: user.role as UserRole,
        professionalRegistration: user.professionalRegistration,
      };
    });
  }

  private toDomain(row: {
    id: string;
    name: string;
    type: string;
    createdAt: Date;
    updatedAt: Date;
    deactivatedAt: Date | null;
    cnpj: string | null;
    institutionalEmail: string | null;
    phone: string | null;
    zipCode: string | null;
    street: string | null;
    number: string | null;
    complement: string | null;
    district: string | null;
    city: string | null;
    state: string | null;
    responsibleManagerId: string | null;
  }): Tenant {
    return new Tenant({
      id: row.id,
      name: row.name,
      type: row.type as TenantType,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deactivatedAt: row.deactivatedAt,
      cnpj: row.cnpj,
      institutionalEmail: row.institutionalEmail,
      phone: row.phone,
      zipCode: row.zipCode,
      street: row.street,
      number: row.number,
      complement: row.complement,
      district: row.district,
      city: row.city,
      state: row.state,
      responsibleManagerId: row.responsibleManagerId,
    });
  }
}
