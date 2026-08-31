import { Injectable } from "@nestjs/common";
import type { TenantType } from "@crop/shared";
import { PrismaService } from "../../../shared/infrastructure/prisma/prisma.service.js";
import { Tenant } from "../domain/tenant.entity.js";
import type { CreateTenantData, TenantRepositoryPort } from "../application/ports/tenant-repository.port.js";

@Injectable()
export class PrismaTenantRepository implements TenantRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateTenantData): Promise<Tenant> {
    const row = await this.prisma.tenant.create({ data: { name: data.name, type: data.type } });
    return this.toDomain(row);
  }

  async findById(id: string): Promise<Tenant | null> {
    const row = await this.prisma.tenant.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async listAll(): Promise<Tenant[]> {
    const rows = await this.prisma.tenant.findMany({ orderBy: { name: "asc" } });
    return rows.map((row) => this.toDomain(row));
  }

  async deactivate(id: string): Promise<void> {
    await this.prisma.tenant.update({ where: { id }, data: { deactivatedAt: new Date() } });
  }

  async reactivate(id: string): Promise<void> {
    await this.prisma.tenant.update({ where: { id }, data: { deactivatedAt: null } });
  }

  private toDomain(row: { id: string; name: string; type: string; createdAt: Date; deactivatedAt: Date | null }): Tenant {
    return new Tenant({
      id: row.id,
      name: row.name,
      type: row.type as TenantType,
      createdAt: row.createdAt,
      deactivatedAt: row.deactivatedAt,
    });
  }
}
