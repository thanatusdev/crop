import { Unit } from "../../domain/unit.entity.js";
import type { EstablishmentType, ExamModality } from "@crop/shared";

export const UNIT_REPOSITORY = Symbol("UNIT_REPOSITORY");

export interface CreateUnitData {
  clinicTenantId: string;
  name: string;
  // Every field below is optional at this layer even though `CreateUnitRequestSchema`
  // requires them for the HTTP path: `CreateEquipmentHandler.resolveUnitId()` still creates
  // a unit through this exact port, with none of this, when a clinic has no unit yet -- see
  // schema.prisma's own note on why the columns stay nullable.
  establishmentType?: EstablishmentType | null;
  technicalManagerId?: string | null;
  declaredModalities?: ExamModality[];
  cnesCode?: string | null;
  phone?: string | null;
  technicalEmail?: string | null;
  zipCode?: string | null;
  street?: string | null;
  number?: string | null;
  complement?: string | null;
  district?: string | null;
  city?: string | null;
  state?: string | null;
}

/**
 * Every field optional -- a real partial update. `undefined` means "leave unchanged" for
 * every key here; `technicalManagerId` is the one field that also accepts `null` as a real
 * value (unassign), matching `UpdateUnitRequestSchema`'s own asymmetry and reasoning. There
 * is no `clinicTenantId` here -- see that schema's own docstring for why a unit's clinic is
 * fixed at creation, not reassignable via update.
 */
export interface UpdateUnitData {
  name?: string;
  establishmentType?: EstablishmentType;
  technicalManagerId?: string | null;
  declaredModalities?: ExamModality[];
  cnesCode?: string | null;
  phone?: string | null;
  technicalEmail?: string | null;
  zipCode?: string;
  street?: string;
  number?: string;
  complement?: string | null;
  district?: string;
  city?: string;
  state?: string;
}

/**
 * How much equipment a unit has, split the same way `roomLabel` and retirement already are:
 * `equipmentCount` is every `Equipment` row pointed at the unit, retired or not -- a
 * decommissioned scanner is still equipment that was linked here, an inventory fact. `rooms`
 * counts distinct non-blank `roomLabel` values among only the unit's *non-retired* equipment,
 * so a room that only ever held a since-retired device doesn't inflate a "rooms in service"
 * count. See `PrismaUnitRepository.summarizeEquipment` for how each is actually computed.
 */
export interface UnitEquipmentSummary {
  equipmentCount: number;
  roomCount: number;
}

/** The technical manager fields a unit DTO denormalizes -- see `UnitSchema.technicalManager`. */
export interface TechnicalManagerSummary {
  id: string;
  name: string;
  professionalRegistration: string | null;
}

export interface UnitRepositoryPort {
  create(data: CreateUnitData): Promise<Unit>;
  findById(id: string): Promise<Unit | null>;
  /**
   * Case-insensitive, scoped to one clinic -- backs the friendly pre-check
   * `CreateUnitHandler`/`UpdateUnitHandler` do before insert, the same precedent
   * `RegisterUserHandler.findByEmail` already sets for a duplicate that would otherwise
   * surface as a raw Postgres unique-violation (this table's own
   * `units_clinicTenantId_lower_name_key` index) instead of a clean `ConflictError`.
   */
  findByClinicAndName(clinicTenantId: string, name: string): Promise<Unit | null>;
  listByClinic(clinicTenantId: string): Promise<Unit[]>;
  /** Every unit across every clinic in `clinicTenantIds` -- backs `GET /units?scope=all`. */
  listByClinics(clinicTenantIds: string[]): Promise<Unit[]>;
  update(id: string, data: UpdateUnitData): Promise<Unit>;
  setDeactivated(id: string, deactivated: boolean): Promise<Unit>;
  /**
   * Reaches directly into the `equipment` table via Prisma rather than injecting
   * `EQUIPMENT_REPOSITORY`: `EquipmentModule` already imports `UnitsModule` (for
   * `UNIT_REPOSITORY`), so the reverse edge would be a module import cycle. This is this
   * API's first `groupBy` -- needed because `GET /equipment` is tenant-scoped, so a
   * platform admin viewing another clinic's units cannot derive these counts client-side
   * the way every other count in this app is derived (see `ConsoleShell`'s equipment-health
   * pill and unit-count badge).
   */
  summarizeEquipment(unitIds: string[]): Promise<Record<string, UnitEquipmentSummary>>;
  /**
   * Denormalizes the chosen technical manager's display name and professional registration
   * onto the unit DTO, keyed by user id. Reaches directly into the `users` table for the
   * same reason `summarizeEquipment` reaches into `equipment`: a batch, read-model lookup
   * for a handful of ids doesn't need the full `UserRepositoryPort`/domain-entity machinery
   * `USER_REPOSITORY` exists for (one user at a time, by email or id, for auth/admin
   * actions) -- even though `IamModule` is already imported here for
   * `USER_CLINIC_MEMBERSHIP_REPOSITORY`, and `USER_REPOSITORY` is available through it.
   */
  summarizeTechnicalManagers(userIds: string[]): Promise<Record<string, TechnicalManagerSummary>>;
}
