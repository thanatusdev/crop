import { EstablishmentType, type UnitDto } from "@crop/shared";

/**
 * Fully-qualified translation keys for an establishment type -- literal unions, not
 * assembled templates, for the same compile-time-checking reason `equipment-display.ts`'s
 * `ModalityLabelKey` already is (see that file's own docstring).
 *
 * `EstablishmentType.CLINIC` ("this unit is itself a walk-in clinic facility") and
 * `TenantType.CLINIC` ("this whole tenant is a clinic business") are two different enums
 * that happen to share a member name -- not a bug, and not the same concept: a clinic
 * *tenant* can run units of several different facility types (a lab, a hospital wing, and
 * a walk-in clinic all under one company), the same way `EstablishmentType.HOSPITAL` does
 * not imply the tenant itself is a hospital corporation.
 */
export type EstablishmentTypeLabelKey =
  | "unitForm:establishmentLaboratory"
  | "unitForm:establishmentImagingCenter"
  | "unitForm:establishmentHospital"
  | "unitForm:establishmentClinic"
  | "unitForm:establishmentUrgentCare"
  | "unitForm:establishmentMobileUnit";

export const ESTABLISHMENT_TYPE_LABEL_KEY: Record<EstablishmentType, EstablishmentTypeLabelKey> = {
  [EstablishmentType.LABORATORY]: "unitForm:establishmentLaboratory",
  [EstablishmentType.IMAGING_CENTER]: "unitForm:establishmentImagingCenter",
  [EstablishmentType.HOSPITAL]: "unitForm:establishmentHospital",
  [EstablishmentType.CLINIC]: "unitForm:establishmentClinic",
  [EstablishmentType.URGENT_CARE]: "unitForm:establishmentUrgentCare",
  [EstablishmentType.MOBILE_UNIT]: "unitForm:establishmentMobileUnit",
};

/** Stable order for the establishment-type picker and the listing screen's TIPO filter. */
export const ESTABLISHMENT_TYPE_ORDER: readonly EstablishmentType[] = [
  EstablishmentType.LABORATORY,
  EstablishmentType.IMAGING_CENTER,
  EstablishmentType.HOSPITAL,
  EstablishmentType.CLINIC,
  EstablishmentType.URGENT_CARE,
  EstablishmentType.MOBILE_UNIT,
];

/** "Avenida Paulista, 1000 - Bela Vista, São Paulo - SP". `null` if the unit predates the
 * address fields (see the unit_registry migration) and has never been edited since. */
export function formatUnitAddress(unit: UnitDto): string | null {
  if (!unit.street || !unit.city || !unit.state) return null;
  const line1 = [unit.street, unit.number].filter((part): part is string => !!part).join(", ");
  const line2 = [unit.district, `${unit.city} - ${unit.state}`].filter((part): part is string => !!part).join(", ");
  return [line1, line2].filter((part) => part.length > 0).join(" - ");
}

/** "São Paulo - SP" alone, for the table's narrower address column. */
export function formatUnitCityState(unit: UnitDto): string | null {
  if (!unit.city || !unit.state) return null;
  return `${unit.city} - ${unit.state}`;
}

export interface UnitSummary {
  total: number;
  active: number;
  inactive: number;
  /** Share of units currently active, 0-100, rounded to one decimal. */
  activePct: number;
  totalRooms: number;
  totalEquipment: number;
  /** Registered in the current UTC calendar month -- see `summarizeUnits`'s own note on
   * why this is UTC, not the browser's local timezone. */
  newThisMonth: number;
}

/**
 * The listing screen's summary cards, computed from the same array the table renders --
 * the same reasoning `equipment-display.ts`'s `summarize()` already documents: the list is
 * already fully in memory, so a second round trip to a stats endpoint could only introduce
 * a way for the cards and the table to disagree.
 *
 * "This month" is compared in UTC, not the browser's local calendar: `createdAt` is a real
 * insert timestamp (unlike `installedAt`, a user-picked calendar date anchored at UTC
 * midnight), and every other cross-timezone-sensitive display in this app already reads UTC
 * components rather than local ones, for the same reason `formatCalendarDate` does.
 */
export function summarizeUnits(units: readonly UnitDto[]): UnitSummary {
  const now = new Date();
  let active = 0;
  let inactive = 0;
  let totalRooms = 0;
  let totalEquipment = 0;
  let newThisMonth = 0;

  for (const unit of units) {
    if (unit.deactivated) inactive += 1;
    else active += 1;
    totalRooms += unit.roomCount;
    totalEquipment += unit.equipmentCount;

    const createdAt = new Date(unit.createdAt);
    if (createdAt.getUTCFullYear() === now.getUTCFullYear() && createdAt.getUTCMonth() === now.getUTCMonth()) {
      newThisMonth += 1;
    }
  }

  const total = units.length;
  return {
    total,
    active,
    inactive,
    activePct: total === 0 ? 0 : Math.round((active / total) * 1000) / 10,
    totalRooms,
    totalEquipment,
    newThisMonth,
  };
}
