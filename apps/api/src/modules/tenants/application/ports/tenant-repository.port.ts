import { Tenant } from "../../domain/tenant.entity.js";
import type { ExamModality, ResponsibleManagerOption, TenantType, UserRole } from "@crop/shared";

export const TENANT_REPOSITORY = Symbol("TENANT_REPOSITORY");

export interface CreateTenantData {
  name: string;
  type: TenantType;
  // Every field below is optional at this layer even though `CreateTenantRequestSchema`
  // requires them for a CLINIC created through the HTTP path: `infra/seeds/seed.ts` and
  // `bootstrap-superadmin.ts` still create OPERATOR_PROVIDER/PLATFORM tenants through this
  // exact port, with none of this -- see schema.prisma's own note on why the columns stay
  // nullable.
  cnpj?: string | null;
  institutionalEmail?: string | null;
  phone?: string | null;
  zipCode?: string | null;
  street?: string | null;
  number?: string | null;
  complement?: string | null;
  district?: string | null;
  city?: string | null;
  state?: string | null;
}

/**
 * Every field optional -- a real partial update. `responsibleManagerId` is the one field
 * that also accepts `null` as a real value (unassign), matching
 * `UpdateTenantRequestSchema`'s own asymmetry and reasoning. There is no `type` or `cnpj`
 * here -- see that schema's own docstring for why a tenant's type and CNPJ are both fixed
 * at creation.
 */
export interface UpdateTenantData {
  name?: string;
  institutionalEmail?: string;
  phone?: string;
  zipCode?: string;
  street?: string;
  number?: string;
  complement?: string | null;
  district?: string;
  city?: string;
  state?: string;
  responsibleManagerId?: string | null;
}

/**
 * How much equipment/how many units a clinic has, and which modalities are actually
 * installed (the equipment-listing screen's real "Tipo de Equipamento" values for this
 * tenant, not `Unit.declaredModalities` -- a clinic's *installed* fleet, not what any one
 * unit declares itself equipped for). See `PrismaTenantRepository.summarizeClinics`'s own
 * docstring for why this reaches into `equipment`/`units` directly rather than through
 * `EQUIPMENT_REPOSITORY`/`UNIT_REPOSITORY`. Structurally all-zero for an `OPERATOR_PROVIDER`
 * -- see `OperatorSummary` for the metrics that describe one of those instead.
 */
export interface ClinicSummary {
  equipmentCount: number;
  unitCount: number;
  modalities: ExamModality[];
}

/**
 * The operadora-listing counterpart to `ClinicSummary` -- how many `OperatorAgreement` rows
 * naming this tenant are `ACTIVE` (on either side: a `CLINIC` and an `OPERATOR_PROVIDER` are
 * each a party the same way), and how many users call this tenant home. `userCount` reaches
 * into `users` directly for the same cross-module reason `summarizeResponsibleManagers`
 * already does; `activeAgreementCount` reaches into `operator_agreements` for the same
 * reason, one new edge rather than injecting `AGREEMENT_REPOSITORY` and risking the module
 * cycle that port's own consumers (`AgreementsModule`/`AccessModule`) already navigate
 * around `TenantsModule`.
 */
export interface OperatorSummary {
  activeAgreementCount: number;
  userCount: number;
}

/** The tenant/role/activation/lock facts `ResponsibleManagerValidator` needs to decide
 * eligibility -- deliberately not a full `User` domain entity; see this port's own note on
 * why tenant-module code reaches into `users` directly instead of through `USER_REPOSITORY`. */
export interface ResponsibleManagerCandidate {
  id: string;
  tenantId: string;
  role: UserRole;
  activatedAt: Date | null;
  lockedAt: Date | null;
}

/** The chosen responsible manager's display name and registration, denormalized onto
 * `TenantDto.responsibleManager` -- see `UnitRepositoryPort.summarizeTechnicalManagers` for
 * the identical shape and reasoning on the unit side. */
export interface ResponsibleManagerSummary {
  id: string;
  name: string;
  professionalRegistration: string | null;
}

export interface TenantRepositoryPort {
  create(data: CreateTenantData): Promise<Tenant>;
  findById(id: string): Promise<Tenant | null>;
  /**
   * Case-insensitive-irrelevant (CNPJ is digits, not text) exact match -- backs the friendly
   * pre-check `CreateTenantHandler` does before insert, the same precedent
   * `RegisterUserHandler.findByEmail`/`UnitRepositoryPort.findByClinicAndName` already set
   * for a duplicate that would otherwise surface as a raw Postgres unique-violation instead
   * of a clean `ConflictError`.
   */
  findByCnpj(cnpj: string): Promise<Tenant | null>;
  /** The reverse of `responsibleManagerId` -- which tenant (if any) currently names this
   * user as its "Gestor Responsável". Backs `UpdateUserHandler`'s FK guard: a role change
   * that would make this user ineligible for that tenant's responsible-manager slot must be
   * rejected, not silently leave the tenant pointing at someone no longer eligible. `null`
   * when nobody has this user assigned -- the common case, checked before doing anything
   * more expensive. */
  findByResponsibleManagerId(userId: string): Promise<Tenant | null>;
  /** `filter.type` undefined (or omitted) lists every tenant of every type -- see
   * `ListTenantsQuery`'s own docstring. Every existing caller that predates this filter
   * (`ListClinicOptionsHandler`, `ListOperatorOptionsHandler`, both of which must see the
   * whole platform regardless of what any one screen is filtering to) keeps calling this
   * with no argument at all, which this signature still accepts. */
  listAll(filter?: { type?: TenantType }): Promise<Tenant[]>;
  update(id: string, data: UpdateTenantData): Promise<Tenant>;
  deactivate(id: string): Promise<void>;
  reactivate(id: string): Promise<void>;
  /**
   * Reaches directly into `equipment`/`units` via Prisma rather than injecting
   * `EQUIPMENT_REPOSITORY`/`UNIT_REPOSITORY`: `UnitsModule` already imports `TenantsModule`
   * (for `ClinicAccessChecker`'s own `TENANT_REPOSITORY` dependency), so either reverse edge
   * would be a module import cycle. This is the API's second `groupBy`-shaped aggregate
   * (the first was `UnitRepositoryPort.summarizeEquipment`), for the identical reason:
   * `GET /equipment` is tenant-scoped, so a platform admin viewing another tenant's clinics
   * cannot derive these counts client-side the way every other count in this app is derived.
   */
  summarizeClinics(tenantIds: string[]): Promise<Record<string, ClinicSummary>>;
  /** The operadora-listing counterpart to `summarizeClinics` -- see `OperatorSummary`. */
  summarizeOperators(tenantIds: string[]): Promise<Record<string, OperatorSummary>>;
  /**
   * Reaches directly into `users` for the same reason, in the opposite direction:
   * `IamModule` already imports `TenantsModule` (for `TENANT_REPOSITORY`, used by
   * `LoginHandler`/`RefreshTokensHandler`/`RegisterUserHandler`), so `TenantsModule`
   * importing `IamModule` back for `USER_REPOSITORY` would be the cycle this time.
   */
  summarizeResponsibleManagers(userIds: string[]): Promise<Record<string, ResponsibleManagerSummary>>;
  findResponsibleManagerCandidate(userId: string): Promise<ResponsibleManagerCandidate | null>;
  /** `role` is the one `responsibleManagerRoleFor(tenant.type)` names -- the caller (see
   * `ListResponsibleManagerOptionsHandler`) resolves it from the tenant's own type rather
   * than this method guessing from `tenantId` alone. */
  listResponsibleManagerOptions(tenantId: string, role: UserRole): Promise<ResponsibleManagerOption[]>;
}
