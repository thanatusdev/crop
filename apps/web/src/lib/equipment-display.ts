import { EquipmentStatus, ExamModality, type EquipmentDto } from "@crop/shared";

/**
 * What a single status pill should say for one piece of equipment.
 *
 * This exists because "status" is genuinely two fields (see `EquipmentSchema`): `deactivated`
 * is a lifecycle decision an admin made, `status` is device health the poller observes. A
 * retired device is skipped by the poller, so its `status` is frozen at whatever it was when
 * it left service -- very often `ONLINE`. Rendering `status` alone would therefore label a
 * decommissioned scanner "Ativo", which is why `deactivated` has to be checked first, and why
 * that ordering lives here once rather than being re-derived on the listing screen, in the
 * stat-card counts, and in the CSV export.
 */
export type DisplayStatus = "inactive" | "maintenance" | "online" | "degraded" | "offline";

export function displayStatusOf(equipment: EquipmentDto): DisplayStatus {
  if (equipment.deactivated) return "inactive";
  if (equipment.status === EquipmentStatus.MAINTENANCE) return "maintenance";
  if (equipment.status === EquipmentStatus.ONLINE) return "online";
  if (equipment.status === EquipmentStatus.DEGRADED) return "degraded";
  return "offline";
}

/** Tailwind equivalent for shadcn's `Badge` -- same five hex pairs as the old `.badge.online`/
 * `.offline`/`.degraded`/`.maintenance`/`.inactive` styles.css rules (self-contained pills,
 * already contrast-verified: 6.1-7.98:1), carried over rather than re-picked. Pair with
 * `<Badge className={cn("border-transparent", tailwindBadgeClassOf(status))}>`. */
export function tailwindBadgeClassOf(status: DisplayStatus): string {
  const byStatus: Record<DisplayStatus, string> = {
    online: "bg-[#1d3d2b] text-[#5fdc8a]",
    offline: "bg-[#3d1d1d] text-[#ff8b8b]",
    degraded: "bg-[#3d341d] text-[#ffd76b]",
    maintenance: "bg-[#1d2f3d] text-[#6fb1ff]",
    inactive: "bg-[#3a3a3a] text-[#d8d8d8]",
  };
  return byStatus[status];
}

/** i18n key suffix in the `adminEquipment` namespace, e.g. `statusOnline`. */
export type StatusLabelKey =
  | "adminEquipment:statusInactive"
  | "adminEquipment:statusMaintenance"
  | "adminEquipment:statusActive"
  | "adminEquipment:statusDegraded"
  | "adminEquipment:statusOffline";

/**
 * Returns the *fully qualified* translation key, as a literal union rather than an assembled
 * `` `adminEquipment:${string}` `` template.
 *
 * That is deliberate and worth the extra verbosity: `i18next.d.ts` augments i18next so every
 * key is checked against `pt-BR.ts`'s real shape at compile time, and a template-literal type
 * defeats that check entirely -- it would accept a key that does not exist and silently render
 * the key name at runtime. Spelling the union out keeps `tsc` verifying these five keys.
 */
export function statusLabelKeyOf(status: DisplayStatus): StatusLabelKey {
  const byStatus: Record<DisplayStatus, StatusLabelKey> = {
    inactive: "adminEquipment:statusInactive",
    maintenance: "adminEquipment:statusMaintenance",
    online: "adminEquipment:statusActive",
    degraded: "adminEquipment:statusDegraded",
    offline: "adminEquipment:statusOffline",
  };
  return byStatus[status];
}

/**
 * Display abbreviations for the modality enum. Portuguese, and only here -- the enum itself
 * stays in English (see `ExamModality`'s own docstring), and these three letters are what the
 * listing screen's per-modality counters and table chips show.
 */
export const MODALITY_ABBREVIATION: Record<ExamModality, string> = {
  [ExamModality.MRI]: "RM",
  [ExamModality.CT]: "TC",
  [ExamModality.ULTRASOUND]: "USG",
  [ExamModality.XRAY]: "RX",
};

/**
 * Fully-qualified translation keys for a modality's full name and supporting hint -- literal
 * unions, not assembled templates, for the same compile-time-checking reason as
 * `statusLabelKeyOf` above.
 */
export type ModalityLabelKey =
  | "equipmentForm:modalityMri"
  | "equipmentForm:modalityCt"
  | "equipmentForm:modalityUltrasound"
  | "equipmentForm:modalityXray";
export type ModalityHintKey =
  | "equipmentForm:modalityMriHint"
  | "equipmentForm:modalityCtHint"
  | "equipmentForm:modalityUltrasoundHint"
  | "equipmentForm:modalityXrayHint";

export const MODALITY_LABEL_KEY: Record<ExamModality, ModalityLabelKey> = {
  [ExamModality.MRI]: "equipmentForm:modalityMri",
  [ExamModality.CT]: "equipmentForm:modalityCt",
  [ExamModality.ULTRASOUND]: "equipmentForm:modalityUltrasound",
  [ExamModality.XRAY]: "equipmentForm:modalityXray",
};

export const MODALITY_HINT_KEY: Record<ExamModality, ModalityHintKey> = {
  [ExamModality.MRI]: "equipmentForm:modalityMriHint",
  [ExamModality.CT]: "equipmentForm:modalityCtHint",
  [ExamModality.ULTRASOUND]: "equipmentForm:modalityUltrasoundHint",
  [ExamModality.XRAY]: "equipmentForm:modalityXrayHint",
};

/** Stable order for pickers and counters, so they never depend on `Object.keys` ordering. */
export const MODALITY_ORDER: readonly ExamModality[] = [ExamModality.MRI, ExamModality.CT, ExamModality.ULTRASOUND, ExamModality.XRAY];

export interface EquipmentSummary {
  total: number;
  active: number;
  maintenance: number;
  inactive: number;
  degraded: number;
  offline: number;
  byModality: Record<ExamModality, number>;
  /** Rows registered before modality existed as a field -- see the migration's note. */
  unclassified: number;
  /** Share of the fleet currently operating normally, 0-100, rounded to one decimal. */
  activePct: number;
}

/**
 * The listing screen's four summary cards, computed from the same array the table renders --
 * deliberately not from a separate `/equipment/stats` endpoint. The list is already fully in
 * memory (the API returns a tenant's equipment unpaginated), so a second round trip could only
 * introduce a way for the cards and the table to disagree with each other.
 *
 * `active + maintenance + inactive` does NOT necessarily equal `total`: `degraded` and
 * `offline` equipment is in service but not operating, and the mock's three buckets had
 * nowhere to put it. Rather than quietly fold those rows into one of the three (each of which
 * would be a lie about a device with a connection problem), they are counted separately and
 * surfaced as a note under the relevant card.
 */
export function summarize(equipment: readonly EquipmentDto[]): EquipmentSummary {
  const byModality: Record<ExamModality, number> = {
    [ExamModality.MRI]: 0,
    [ExamModality.CT]: 0,
    [ExamModality.ULTRASOUND]: 0,
    [ExamModality.XRAY]: 0,
  };
  let active = 0;
  let maintenance = 0;
  let inactive = 0;
  let degraded = 0;
  let offline = 0;
  let unclassified = 0;

  for (const item of equipment) {
    if (item.modality) byModality[item.modality] += 1;
    else unclassified += 1;

    switch (displayStatusOf(item)) {
      case "online":
        active += 1;
        break;
      case "maintenance":
        maintenance += 1;
        break;
      case "inactive":
        inactive += 1;
        break;
      case "degraded":
        degraded += 1;
        break;
      case "offline":
        offline += 1;
        break;
    }
  }

  const total = equipment.length;
  return {
    total,
    active,
    maintenance,
    inactive,
    degraded,
    offline,
    byModality,
    unclassified,
    activePct: total === 0 ? 0 : Math.round((active / total) * 1000) / 10,
  };
}

/**
 * Formats an ISO date (or a `Date`) as `dd/mm/yyyy`, reading the timestamp's UTC components
 * rather than the browser's local ones. `installedAt` is a calendar date stored at UTC
 * midnight (see `CalendarDateSchema`); rendering it in local time would show the previous day
 * for every user west of UTC.
 */
export function formatCalendarDate(value: Date | string | null): string | null {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

/** `YYYY-MM-DD` for an `<input type="date">`, again from UTC components. */
export function toDateInputValue(value: Date | string | null): string {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}
