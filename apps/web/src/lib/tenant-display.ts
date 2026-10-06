import { formatCnpj as formatCnpjDigits, type TenantDto } from "@crop/shared";

/**
 * Tenant-neutral counterparts to `clinic-display.ts`'s own `formatClinicCnpj`/
 * `formatClinicCityState` -- introduced once `AdminOperatorsPage` needed the identical
 * formatting for an `OPERATOR_PROVIDER` row and copying three one-line functions stopped
 * being the cheaper option. `clinic-display.ts` itself is left alone: it already shipped
 * and is already covered by the clinic listing's own tests, and nothing about these
 * functions is actually clinic-specific -- they only ever read `cnpj`/`street`/`city`/
 * `state`, fields `TenantDto` carries for either type.
 */
export function formatTenantCnpj(tenant: TenantDto): string | null {
  return tenant.cnpj ? formatCnpjDigits(tenant.cnpj) : null;
}

/** "Avenida Faria Lima, 500 - Itaim Bibi, São Paulo - SP". `null` if the tenant predates the
 * address fields and has never been edited since. */
export function formatTenantAddress(tenant: TenantDto): string | null {
  if (!tenant.street || !tenant.city || !tenant.state) return null;
  const line1 = [tenant.street, tenant.number].filter((part): part is string => !!part).join(", ");
  const line2 = [tenant.district, `${tenant.city} - ${tenant.state}`].filter((part): part is string => !!part).join(", ");
  return [line1, line2].filter((part) => part.length > 0).join(" - ");
}

/** "São Paulo - SP" alone, for the table's narrower address column. */
export function formatTenantCityState(tenant: TenantDto): string | null {
  if (!tenant.city || !tenant.state) return null;
  return `${tenant.city} - ${tenant.state}`;
}

export interface OperatorListSummary {
  total: number;
  active: number;
  inactive: number;
  /** Share of operadoras currently active, 0-100, rounded to one decimal. */
  activePct: number;
  /** Sum of `activeAgreementCount` across the listed operadoras -- how many clinics, in
   * total, currently have a live contract with one of them. */
  totalActiveAgreements: number;
  /** Operadoras with at least one active agreement -- the ones actually in use, as opposed
   * to registered but never contracted. */
  withActiveAgreement: number;
  /** Sum of `userCount` -- how many operator-side accounts exist across every listed
   * company. */
  totalUsers: number;
  /** Registered in the current UTC calendar month -- see `summarizeClinics`'s identical
   * note on why this reads UTC components, not the browser's local timezone. */
  newThisMonth: number;
}

/**
 * The operadora listing screen's summary cards, computed from the same array the table
 * renders -- same "already fully in memory, don't risk a second source of truth" reasoning
 * `summarizeClinics`/`summarizeUnits` already document.
 */
export function summarizeOperators(operators: readonly TenantDto[]): OperatorListSummary {
  const now = new Date();
  let active = 0;
  let inactive = 0;
  let totalActiveAgreements = 0;
  let withActiveAgreement = 0;
  let totalUsers = 0;
  let newThisMonth = 0;

  for (const operator of operators) {
    if (operator.deactivated) inactive += 1;
    else active += 1;

    totalActiveAgreements += operator.activeAgreementCount;
    if (operator.activeAgreementCount > 0) withActiveAgreement += 1;
    totalUsers += operator.userCount;

    const createdAt = new Date(operator.createdAt);
    if (createdAt.getUTCFullYear() === now.getUTCFullYear() && createdAt.getUTCMonth() === now.getUTCMonth()) {
      newThisMonth += 1;
    }
  }

  const total = operators.length;
  return {
    total,
    active,
    inactive,
    activePct: total === 0 ? 0 : Math.round((active / total) * 1000) / 10,
    totalActiveAgreements,
    withActiveAgreement,
    totalUsers,
    newThisMonth,
  };
}
