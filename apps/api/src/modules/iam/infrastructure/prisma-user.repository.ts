import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { UserRole } from "@crop/shared";
import { PrismaService } from "../../../shared/infrastructure/prisma/prisma.service.js";
import { User } from "../domain/user.entity.js";
import type { CreateUserData, UpdateUserData, UserRepositoryPort } from "../application/ports/user-repository.port.js";

@Injectable()
export class PrismaUserRepository implements UserRepositoryPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService
  ) {}

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
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.user.create({
        data: {
          tenantId: data.tenantId,
          email: data.email,
          passwordHash: data.passwordHash,
          role: data.role,
          mfaSecret: data.mfaSecret,
          firstName: data.firstName,
          lastName: data.lastName,
          professionalRegistration: data.professionalRegistration ?? null,
          mustChangePassword: data.mustChangePassword,
          activatedAt: data.activatedAt,
          invitedAt: data.invitedAt,
        },
      });
      // See UserRepositoryPort.create's own docstring: without this, a brand-new account's
      // first self-service change would have empty history and could trivially "rotate"
      // straight back to the temp password an admin just set.
      await tx.passwordHistory.create({ data: { userId: row.id, passwordHash: data.passwordHash } });
      return this.toDomain(row);
    });
  }

  async update(id: string, data: UpdateUserData): Promise<User> {
    const row = await this.prisma.user.update({
      where: { id },
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        professionalRegistration: data.professionalRegistration,
        role: data.role,
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

  async setPassword(userId: string, passwordHash: string, options: { mustChangePassword: boolean }): Promise<void> {
    const depth = this.config.get<number>("PASSWORD_HISTORY_DEPTH", 5);
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          passwordChangedAt: now,
          // Unconditional, for every caller -- see UserRepositoryPort.setPassword's own
          // docstring on why this is the simplest rule to reason about.
          sessionsRevokedAt: now,
          mustChangePassword: options.mustChangePassword,
        },
      });
      await tx.passwordHistory.create({ data: { userId, passwordHash } });

      // Prune back down to `depth`: the row just inserted counts as the 1st of `depth`
      // kept, so anything beyond that -- ordered newest first -- is deleted.
      const stale = await tx.passwordHistory.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        skip: depth,
        select: { id: true },
      });
      if (stale.length > 0) {
        await tx.passwordHistory.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
      }
    });
  }

  async recentPasswordHashes(userId: string, limit: number): Promise<string[]> {
    const rows = await this.prisma.passwordHistory.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { passwordHash: true },
    });
    return rows.map((row) => row.passwordHash);
  }

  async activate(userId: string, passwordHash: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, activatedAt: new Date(), passwordChangedAt: new Date(), mustChangePassword: false },
      });
      await tx.passwordHistory.create({ data: { userId, passwordHash } });
    });
  }

  async summarizeDisplayNames(userIds: string[]): Promise<Record<string, string>> {
    const names: Record<string, string> = {};
    if (userIds.length === 0) return names;
    const rows = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    for (const row of rows) {
      names[row.id] = this.displayNameOf(row);
    }
    return names;
  }

  async summarizeProfiles(userIds: string[]): Promise<Record<string, { name: string; professionalRegistration: string | null }>> {
    const profiles: Record<string, { name: string; professionalRegistration: string | null }> = {};
    if (userIds.length === 0) return profiles;
    const rows = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, firstName: true, lastName: true, email: true, professionalRegistration: true },
    });
    for (const row of rows) {
      profiles[row.id] = { name: this.displayNameOf(row), professionalRegistration: row.professionalRegistration };
    }
    return profiles;
  }

  // Same fallback as UnitRepositoryPort.summarizeTechnicalManagers -- a name is "whatever
  // identifies this person", not a required firstName/lastName pair.
  private displayNameOf(row: { firstName: string | null; lastName: string | null; email: string }): string {
    const full = [row.firstName, row.lastName].filter((part): part is string => !!part).join(" ");
    return full.length > 0 ? full : row.email.split("@")[0]!;
  }

  private toDomain(row: {
    id: string;
    tenantId: string;
    email: string;
    passwordHash: string;
    role: string;
    firstName: string | null;
    lastName: string | null;
    professionalRegistration: string | null;
    mfaSecret: string | null;
    mfaEnabledAt: Date | null;
    lastLoginAt: Date | null;
    lockedAt: Date | null;
    sessionsRevokedAt: Date | null;
    passwordChangedAt: Date;
    mustChangePassword: boolean;
    invitedAt: Date | null;
    activatedAt: Date | null;
  }): User {
    return new User({
      id: row.id,
      tenantId: row.tenantId,
      email: row.email,
      passwordHash: row.passwordHash,
      role: row.role as UserRole,
      firstName: row.firstName,
      lastName: row.lastName,
      professionalRegistration: row.professionalRegistration,
      mfaSecret: row.mfaSecret,
      mfaEnabledAt: row.mfaEnabledAt,
      lastLoginAt: row.lastLoginAt,
      lockedAt: row.lockedAt,
      sessionsRevokedAt: row.sessionsRevokedAt,
      passwordChangedAt: row.passwordChangedAt,
      mustChangePassword: row.mustChangePassword,
      invitedAt: row.invitedAt,
      activatedAt: row.activatedAt,
    });
  }
}
