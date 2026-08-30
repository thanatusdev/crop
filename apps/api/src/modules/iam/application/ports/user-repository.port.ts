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
  create(data: CreateUserData): Promise<User>;
  activateMfa(userId: string): Promise<void>;
  recordLogin(userId: string): Promise<void>;
}
