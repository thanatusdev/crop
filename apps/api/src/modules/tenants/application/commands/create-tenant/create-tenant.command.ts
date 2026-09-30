import type { TenantType } from "@crop/shared";

/**
 * A clinic's institutional identity and address -- required by `CreateTenantRequestSchema`
 * when `type === CLINIC`, but the command itself keeps them as one nullable object rather
 * than flattening ten more constructor parameters onto an already-3-parameter command: the
 * same reshaping `CreateUnitCommand`/`CreateEquipmentCommand` went through once their own
 * clinical-identity fields arrived. `null` for every non-CLINIC tenant this same command
 * still creates (`infra/seeds/seed.ts`'s OPERATOR_PROVIDER, `bootstrap-superadmin.ts`'s
 * PLATFORM) -- neither has a CNPJ or a clinical address, by design.
 */
export interface NewClinicDetails {
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
}

export class CreateTenantCommand {
  constructor(
    public readonly name: string,
    public readonly type: TenantType,
    // Null for the seed script / bootstrap-superadmin.ts, where there is no human admin
    // acting yet -- same reasoning as RegisterUserCommand.actingUserId.
    public readonly actingAdminId: string | null = null,
    public readonly clinicDetails: NewClinicDetails | null = null
  ) {}
}
