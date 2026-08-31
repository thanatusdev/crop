import { Injectable } from "@nestjs/common";
import type { UserRole } from "@crop/shared";
import { PrismaService } from "../../../shared/infrastructure/prisma/prisma.service.js";
import { User } from "../domain/user.entity.js";
import type { CreateUserData, UserRepositoryPort } from "../application/ports/user-repository.port.js";

@Injectable()
export class PrismaUserRepository implements UserRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<User | null> {
    const row = await this.prisma.user.findUnique({ where: { email } });
    return row ? this.toDomain(row) : null;
  }

  async findById(id: string): Promise<User | null> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async findByTenant(tenantId: string): Promise<User[]> {
    const rows = await this.prisma.user.findMany({ where: { tenantId }, orderBy: { email: "asc" } });
    return rows.map((row) => this.toDomain(row));
  }

  async create(data: CreateUserData): Promise<User> {
    const row = await this.prisma.user.create({
      data: {
        tenantId: data.tenantId,
        email: data.email,
        passwordHash: data.passwordHash,
        role: data.role,
        mfaSecret: data.mfaSecret,
      },
    });
    return this.toDomain(row);
  }

  async activateMfa(userId: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { mfaEnabledAt: new Date() } });
  }

  async recordLogin(userId: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  }

  async lock(userId: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { lockedAt: new Date() } });
  }

  async unlock(userId: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { lockedAt: null } });
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  }

  private toDomain(row: {
    id: string;
    tenantId: string;
    email: string;
    passwordHash: string;
    role: string;
    mfaSecret: string | null;
    mfaEnabledAt: Date | null;
    lastLoginAt: Date | null;
    lockedAt: Date | null;
  }): User {
    return new User({
      id: row.id,
      tenantId: row.tenantId,
      email: row.email,
      passwordHash: row.passwordHash,
      role: row.role as UserRole,
      mfaSecret: row.mfaSecret,
      mfaEnabledAt: row.mfaEnabledAt,
      lastLoginAt: row.lastLoginAt,
      lockedAt: row.lockedAt,
    });
  }
}
