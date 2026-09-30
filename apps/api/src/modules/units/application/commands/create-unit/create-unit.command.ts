import type { EstablishmentType, ExamModality, UserRole } from "@crop/shared";

/**
 * The unit to register. A single object rather than growing the constructor's own
 * parameter list -- the same reshaping `CreateEquipmentCommand` went through once its
 * clinical-identity fields arrived, for the identical reason: past a handful of same-typed
 * neighbours (`street`/`district`/`city`, `cnesCode`/`phone`/`technicalEmail`), positional
 * arguments become a column of bare strings any two of which could be silently transposed
 * with nothing -- not the compiler, not a test -- noticing.
 */
export interface NewUnit {
  name: string;
  // Required from here on -- the whole point of the registration screen is that a unit's
  // institutional identity is known at the moment it's registered. Nullable in the
  // database only for rows that predate this (see the unit_registry migration).
  establishmentType: EstablishmentType;
  technicalManagerId: string;
  declaredModalities: ExamModality[];
  zipCode: string;
  street: string;
  number: string;
  complement: string | null;
  district: string;
  city: string;
  state: string;
  // Optional even for a new unit -- regulatory/contact metadata this platform never reads
  // for anything, the same status Equipment's DICOM trio has.
  cnesCode: string | null;
  phone: string | null;
  technicalEmail: string | null;
}

export class CreateUnitCommand {
  constructor(
    public readonly clinicTenantId: string,
    public readonly unit: NewUnit,
    public readonly actingAdminId: string | null = null,
    public readonly actingAdminTenantId: string | null = null,
    public readonly actingRole: UserRole | null = null
  ) {}
}
