import { User } from "../../domain/user.entity.js";

export const USER_REPOSITORY = Symbol("USER_REPOSITORY");

export interface CreateUserData {
  tenantId: string;
  email: string;
  passwordHash: string;
  role: User["role"];
  mfaSecret: string;
}

export interface UserRepositoryPort {
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  findByTenant(tenantId: string): Promise<User[]>;
  create(data: CreateUserData): Promise<User>;
  activateMfa(userId: string): Promise<void>;
  recordLogin(userId: string): Promise<void>;
  lock(userId: string): Promise<void>;
  unlock(userId: string): Promise<void>;
  updatePasswordHash(userId: string, passwordHash: string): Promise<void>;
}
