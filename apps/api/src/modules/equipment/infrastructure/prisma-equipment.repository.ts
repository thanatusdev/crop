import { Injectable } from "@nestjs/common";
import type { EquipmentStatus, MouseMode, TargetOs } from "@crop/shared";
import { PrismaService } from "../../../shared/infrastructure/prisma/prisma.service.js";
import { Equipment } from "../domain/equipment.entity.js";
import type {
  CreateEquipmentData,
  EquipmentConnectionSecrets,
  EquipmentRepositoryPort,
} from "../application/ports/equipment-repository.port.js";

@Injectable()
export class PrismaEquipmentRepository implements EquipmentRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateEquipmentData): Promise<Equipment> {
    const row = await this.prisma.equipment.create({ data });
    return this.toDomain(row);
  }

  async findById(id: string): Promise<Equipment | null> {
    const row = await this.prisma.equipment.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async listByTenant(tenantId: string): Promise<Equipment[]> {
    const rows = await this.prisma.equipment.findMany({ where: { tenantId }, orderBy: { name: "asc" } });
    return rows.map((row) => this.toDomain(row));
  }

  async listAll(): Promise<Equipment[]> {
    const rows = await this.prisma.equipment.findMany({ orderBy: { name: "asc" } });
    return rows.map((row) => this.toDomain(row));
  }

  async updateStatus(id: string, status: EquipmentStatus): Promise<void> {
    await this.prisma.equipment.update({ where: { id }, data: { status } });
  }

  async getConnectionSecrets(id: string): Promise<EquipmentConnectionSecrets | null> {
    const row = await this.prisma.equipment.findUnique({
      where: { id },
      select: { pikvmHost: true, pikvmUser: true, pikvmPasswordCiphertext: true, pikvmTotpSecretCiphertext: true },
    });
    return row ?? null;
  }

  private toDomain(row: {
    id: string;
    tenantId: string;
    name: string;
    status: string;
    pikvmHost: string;
    cameraUrl: string | null;
    targetOs: string;
    keymap: string;
    mouseMode: string;
    screenWidth: number;
    screenHeight: number;
  }): Equipment {
    return new Equipment({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      status: row.status as EquipmentStatus,
      pikvmHost: row.pikvmHost,
      cameraUrl: row.cameraUrl,
      targetOs: row.targetOs as TargetOs,
      keymap: row.keymap,
      mouseMode: row.mouseMode as MouseMode,
      screenWidth: row.screenWidth,
      screenHeight: row.screenHeight,
    });
  }
}
