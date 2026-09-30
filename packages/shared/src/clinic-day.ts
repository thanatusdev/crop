/**
 * Single source of truth for "what day/time is it, clinically" -- shared by `apps/api`
 * (day-scoped queue queries, `GET /queue?date=`) and `apps/web` (rendering/editing a queue
 * entry's `scheduledAt`), specifically so the two sides cannot silently disagree the way they
 * already had: `NursingPage.tsx`'s exam-detail form used to write a nurse's typed time as a
 * bare UTC instant and read it back the same way, while a separate formatter rendered times
 * in the browser's local zone -- self-consistent only by accident, and wrong the moment a
 * scheduled time is compared against a server-computed "today" boundary (this feature's own
 * "N Pacientes Hoje" count).
 *
 * This app is pt-BR-only (see `docs/architecture.md`), so a single configured timezone is
 * honest rather than a simplification -- there is no per-clinic/per-region timezone anywhere
 * in the data model, and every seeded clinic is Brazilian. `apps/api` reads the real,
 * deployment-configured value from `CLINIC_TIME_ZONE` (see `env.validation.ts`) and passes it
 * explicitly to every function here; `apps/web` has no server env to read and always uses
 * `DEFAULT_CLINIC_TIME_ZONE` -- both sides land on the same IANA zone in practice, but through
 * the same functions rather than two independent implementations.
 */
export const DEFAULT_CLINIC_TIME_ZONE = "America/Sao_Paulo";

/** How far `timeZone`'s wall clock is from UTC at `utcInstant`, in milliseconds (e.g. -3h for
 * America/Sao_Paulo) -- `Intl.DateTimeFormat` re-renders the instant in the target zone and
 * measures the difference against interpreting that same rendering as UTC. No date library:
 * `Intl` with an explicit `timeZone` is standard, dependency-free, and already how every other
 * date-in-a-zone need in this codebase would be met if one existed. */
function timeZoneOffsetMs(utcInstant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(utcInstant);
  const field = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asIfUtc = Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"), field("second"));
  return asIfUtc - utcInstant.getTime();
}

/** The UTC instant that reads as `y-mo-d h:mi:s` wall-clock time in `timeZone`. One offset
 * lookup, not an iterative fixed-point search -- exact for a zone with no DST (Brazil
 * abolished it nationally in 2019, so `DEFAULT_CLINIC_TIME_ZONE` is a fixed UTC-3 year-round
 * today), and off by at most the size of one DST jump for a zone that does observe it, right
 * at the transition instant itself. Not reached today (the one zone this app actually
 * configures has no DST to be near), recorded here rather than silently assumed. */
function zonedWallClockToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  return new Date(guess - timeZoneOffsetMs(new Date(guess), timeZone));
}

/** The `[gte, lt)` UTC instant range covering one clinical day -- e.g. what "N Pacientes
 * Hoje" and `GET /queue?date=` filter `scheduledAt` (or, when that's null, `createdAt`)
 * against. `day` is `YYYY-MM-DD` in `timeZone`'s own calendar, not UTC's. */
export function clinicDayBounds(day: string, timeZone: string = DEFAULT_CLINIC_TIME_ZONE): { gte: Date; lt: Date } {
  const [y, mo, d] = day.split("-").map(Number) as [number, number, number];
  return {
    gte: zonedWallClockToUtc(y, mo, d, 0, 0, 0, timeZone),
    // `d + 1` deliberately overflows past the month's last day -- `Date.UTC`'s own
    // normalization (not a manual "days in month" table) rolls it into the 1st of next
    // month, exactly the boundary this range needs.
    lt: zonedWallClockToUtc(y, mo, d + 1, 0, 0, 0, timeZone),
  };
}

/** `YYYY-MM-DD` for `date` as a calendar day in `timeZone` -- what "today" means for the
 * room picker's default `date` param, and the inverse of `clinicDayBounds`. `en-CA` is a
 * deliberate trick, not an arbitrary locale choice: `Intl.DateTimeFormat` renders it in
 * `YYYY-MM-DD` order natively, which no formatting/parsing of a `pt-BR` rendering would give
 * for free. */
export function toClinicDayString(date: Date, timeZone: string = DEFAULT_CLINIC_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** Today's `YYYY-MM-DD` in `timeZone` -- the default `date` a nursing room view loads when
 * the nurse hasn't picked a different day. */
export function todayClinicDayString(timeZone: string = DEFAULT_CLINIC_TIME_ZONE): string {
  return toClinicDayString(new Date(), timeZone);
}

/** `HH:mm` for `iso` as wall-clock time in `timeZone` -- the one formatter every queue-card/
 * exam-detail time display should go through, replacing the ad-hoc
 * `toLocaleTimeString("pt-BR", {...})` calls that rendered in the *browser's* zone rather
 * than the clinic's configured one (usually the same zone in practice, but not the same
 * function, which is how the bug this module fixes happened at all). */
export function formatClinicTime(iso: string, timeZone: string = DEFAULT_CLINIC_TIME_ZONE): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/** The UTC ISO instant for wall-clock `time` (`HH:mm`) on clinical day `day` -- the write
 * side of the exam-detail form's "Horário Previsto" field. Paired with `formatClinicTime`
 * (the read side) so a value round-trips through the same zone it was entered in, instead of
 * the previous write-as-UTC/read-as-UTC/display-as-local mismatch. */
export function clinicTimeToUtcIso(day: string, time: string, timeZone: string = DEFAULT_CLINIC_TIME_ZONE): string {
  const [y, mo, d] = day.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  return zonedWallClockToUtc(y, mo, d, h, mi, 0, timeZone).toISOString();
}
