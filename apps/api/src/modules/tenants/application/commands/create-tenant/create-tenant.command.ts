import type { TenantType } from "@crop/shared";

/**
 * A tenant's institutional identity and address -- required by `CreateTenantRequestSchema`
 * for both `CLINIC` and `OPERATOR_PROVIDER`, but the command itself keeps them as one
 * nullable object rather than flattening ten more constructor parameters onto an already
 * -3-parameter command: the same reshaping `CreateUnitCommand`/`CreateEquipmentCommand` went
 * through once their own clinical-identity fields arrived. `null` only for the one tenant
 * this same command still creates without them -- the `PLATFORM` tenant
 * (`bootstrap-superadmin.ts`) and the seed script's own direct `CommandBus.execute` calls,
 * which bypass the HTTP schema's `.superRefine` entirely and so are not forced to supply
 * these the way an HTTP caller is.
 */
export interface NewTenantDetails {
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
    public readonly tenantDetails: NewTenantDetails | null = null
  ) {}
}
