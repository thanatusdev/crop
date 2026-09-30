import { Injectable } from "@nestjs/common";
import type { EstablishmentType, ExamModality } from "@crop/shared";
import { PrismaService } from "../../../shared/infrastructure/prisma/prisma.service.js";
import { Unit } from "../domain/unit.entity.js";
import type {
  CreateUnitData,
  TechnicalManagerSummary,
  UnitEquipmentSummary,
  UnitRepositoryPort,
  UpdateUnitData,
} from "../application/ports/unit-repository.port.js";

@Injectable()
export class PrismaUnitRepository implements UnitRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateUnitData): Promise<Unit> {
    const row = await this.prisma.unit.create({
      data: {
        clinicTenantId: data.clinicTenantId,
        name: data.name,
        establishmentType: data.establishmentType ?? undefined,
        technicalManagerId: data.technicalManagerId ?? undefined,
        declaredModalities: data.declaredModalities ?? [],
        cnesCode: data.cnesCode ?? undefined,
        phone: data.phone ?? undefined,
        technicalEmail: data.technicalEmail ?? undefined,
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

  async findById(id: string): Promise<Unit | null> {
    const row = await this.prisma.unit.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async findByClinicAndName(clinicTenantId: string, name: string): Promise<Unit | null> {
    const row = await this.prisma.unit.findFirst({
      where: { clinicTenantId, name: { equals: name, mode: "insensitive" } },
    });
    return row ? this.toDomain(row) : null;
  }

  async listByClinic(clinicTenantId: string): Promise<Unit[]> {
    const rows = await this.prisma.unit.findMany({ where: { clinicTenantId }, orderBy: { name: "asc" } });
    return rows.map((row) => this.toDomain(row));
  }

  async listByClinics(clinicTenantIds: string[]): Promise<Unit[]> {
    if (clinicTenantIds.length === 0) return [];
    const rows = await this.prisma.unit.findMany({
      where: { clinicTenantId: { in: clinicTenantIds } },
      orderBy: [{ clinicTenantId: "asc" }, { name: "asc" }],
    });
    return rows.map((row) => this.toDomain(row));
  }

  async update(id: string, data: UpdateUnitData): Promise<Unit> {
    const row = await this.prisma.unit.update({ where: { id }, data });
    return this.toDomain(row);
  }

  async setDeactivated(id: string, deactivated: boolean): Promise<Unit> {
    const row = await this.prisma.unit.update({
      where: { id },
      data: { deactivatedAt: deactivated ? new Date() : null },
    });
    return this.toDomain(row);
  }

  async summarizeEquipment(unitIds: string[]): Promise<Record<string, UnitEquipmentSummary>> {
    const summaries: Record<string, UnitEquipmentSummary> = {};
    if (unitIds.length === 0) return summaries;
    for (const unitId of unitIds) summaries[unitId] = { equipmentCount: 0, roomCount: 0 };

    // `equipmentCount`: every row pointed at the unit, retired or not -- a decommissioned
    // scanner is still equipment that was linked here. This API's first `groupBy` (see the
    // port's own docstring on why this goes straight through Prisma rather than
    // EQUIPMENT_REPOSITORY).
    const counts = await this.prisma.equipment.groupBy({
      by: ["unitId"],
      where: { unitId: { in: unitIds } },
      _count: { _all: true },
    });
    for (const row of counts) {
      if (row.unitId) summaries[row.unitId]!.equipmentCount = row._count._all;
    }

    // `roomCount`: distinct non-blank `roomLabel` among only *non-retired* equipment.
    // `groupBy` counts rows, not distinct values of another column, so the distinct-room
    // count is computed here in application code from the raw (unitId, roomLabel) pairs --
    // there are at most a few dozen per unit, nowhere near enough rows for this to matter.
    const roomRows = await this.prisma.equipment.findMany({
      where: { unitId: { in: unitIds }, deactivatedAt: null, roomLabel: { not: null } },
      select: { unitId: true, roomLabel: true },
    });
    const roomsByUnit = new Map<string, Set<string>>();
    for (const row of roomRows) {
      if (!row.unitId || !row.roomLabel || row.roomLabel.trim().length === 0) continue;
      const rooms = roomsByUnit.get(row.unitId) ?? new Set<string>();
      rooms.add(row.roomLabel.trim());
      roomsByUnit.set(row.unitId, rooms);
    }
    for (const [unitId, rooms] of roomsByUnit) {
      if (summaries[unitId]) summaries[unitId]!.roomCount = rooms.size;
    }

    return summaries;
  }

  async summarizeTechnicalManagers(userIds: string[]): Promise<Record<string, TechnicalManagerSummary>> {
    const summaries: Record<string, TechnicalManagerSummary> = {};
    if (userIds.length === 0) return summaries;
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, firstName: true, lastName: true, email: true, professionalRegistration: true },
    });
    for (const user of users) {
      // Same email-local-part fallback `packages/shared/src/password-policy.ts` uses when
      // firstName/lastName are null (historical accounts predate those columns) -- here for
      // display, there for password-policy matching, same reasoning either way: a name is
      // "whatever identifies this person," not a required pair of columns.
      const full = [user.firstName, user.lastName].filter((part): part is string => !!part).join(" ");
      summaries[user.id] = {
        id: user.id,
        name: full.length > 0 ? full : user.email.split("@")[0]!,
        professionalRegistration: user.professionalRegistration,
      };
    }
    return summaries;
  }

  private toDomain(row: {
    id: string;
    clinicTenantId: string;
    name: string;
    deactivatedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    establishmentType: string | null;
    technicalManagerId: string | null;
    declaredModalities: string[];
    cnesCode: string | null;
    phone: string | null;
    technicalEmail: string | null;
    zipCode: string | null;
    street: string | null;
    number: string | null;
    complement: string | null;
    district: string | null;
    city: string | null;
    state: string | null;
  }): Unit {
    return new Unit({
      id: row.id,
      clinicTenantId: row.clinicTenantId,
      name: row.name,
      deactivatedAt: row.deactivatedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      establishmentType: row.establishmentType as EstablishmentType | null,
      technicalManagerId: row.technicalManagerId,
      declaredModalities: row.declaredModalities as ExamModality[],
      cnesCode: row.cnesCode,
      phone: row.phone,
      technicalEmail: row.technicalEmail,
      zipCode: row.zipCode,
      street: row.street,
      number: row.number,
      complement: row.complement,
      district: row.district,
      city: row.city,
      state: row.state,
    });
  }
}
