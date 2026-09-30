import { formatCnpj as formatCnpjDigits, type TenantDto } from "@crop/shared";

/** `"12345678000195"` → `"12.345.678/0001-95"`. `null` when the clinic has no CNPJ at all
 * (a row predating this feature, or an OPERATOR_PROVIDER/PLATFORM tenant -- neither ever
 * reaches this page, since the listing filters to CLINIC, but the helper stays honest). */
export function formatClinicCnpj(clinic: TenantDto): string | null {
  return clinic.cnpj ? formatCnpjDigits(clinic.cnpj) : null;
}

/** "Avenida Paulista, 1000 - Bela Vista, São Paulo - SP". `null` if the clinic predates the
 * address fields and has never been edited since. */
export function formatClinicAddress(clinic: TenantDto): string | null {
  if (!clinic.street || !clinic.city || !clinic.state) return null;
  const line1 = [clinic.street, clinic.number].filter((part): part is string => !!part).join(", ");
  const line2 = [clinic.district, `${clinic.city} - ${clinic.state}`].filter((part): part is string => !!part).join(", ");
  return [line1, line2].filter((part) => part.length > 0).join(" - ");
}

/** "São Paulo - SP" alone, for the table's narrower address column. */
export function formatClinicCityState(clinic: TenantDto): string | null {
  if (!clinic.city || !clinic.state) return null;
  return `${clinic.city} - ${clinic.state}`;
}

export interface ClinicListSummary {
  total: number;
  active: number;
  inactive: number;
  /** Share of clinics currently active, 0-100, rounded to one decimal. */
  activePct: number;
  /** Counted from `isMatriz`, itself derived from each clinic's own CNPJ -- see
   * `cnpj.ts`. `null` (no CNPJ at all) counts toward neither. */
  matrizCount: number;
  filialCount: number;
  totalEquipment: number;
  totalUnits: number;
  /** Clinics with a `responsibleManagerId` set, and that count as a share of the total --
   * the listing's "Gestores Alocados" card. */
  withResponsibleManager: number;
  responsibleManagerCoveragePct: number;
  /** Registered in the current UTC calendar month -- see `summarizeUnits`'s identical note
   * on why this reads UTC components, not the browser's local timezone. */
  newThisMonth: number;
}

/**
 * The listing screen's summary cards, computed from the same array the table renders --
 * the same reasoning `lib/unit-display.ts`'s own `summarizeUnits` already documents: the
 * list is already fully in memory, so a second round trip to a stats endpoint could only
 * introduce a way for the cards and the table to disagree.
 */
export function summarizeClinics(clinics: readonly TenantDto[]): ClinicListSummary {
  const now = new Date();
  let active = 0;
  let inactive = 0;
  let matrizCount = 0;
  let filialCount = 0;
  let totalEquipment = 0;
  let totalUnits = 0;
  let withResponsibleManager = 0;
  let newThisMonth = 0;

  for (const clinic of clinics) {
    if (clinic.deactivated) inactive += 1;
    else active += 1;

    if (clinic.isMatriz === true) matrizCount += 1;
    else if (clinic.isMatriz === false) filialCount += 1;

    totalEquipment += clinic.equipmentCount;
    totalUnits += clinic.unitCount;
    if (clinic.responsibleManagerId) withResponsibleManager += 1;

    const createdAt = new Date(clinic.createdAt);
    if (createdAt.getUTCFullYear() === now.getUTCFullYear() && createdAt.getUTCMonth() === now.getUTCMonth()) {
      newThisMonth += 1;
    }
  }

  const total = clinics.length;
  return {
    total,
    active,
    inactive,
    activePct: total === 0 ? 0 : Math.round((active / total) * 1000) / 10,
    matrizCount,
    filialCount,
    totalEquipment,
    totalUnits,
    withResponsibleManager,
    responsibleManagerCoveragePct: total === 0 ? 0 : Math.round((withResponsibleManager / total) * 1000) / 10,
    newThisMonth,
  };
}
