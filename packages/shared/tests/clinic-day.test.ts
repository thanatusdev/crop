import { describe, expect, it } from "vitest";
import {
  clinicDayBounds,
  clinicTimeToUtcIso,
  DEFAULT_CLINIC_TIME_ZONE,
  formatClinicTime,
  toClinicDayString,
  todayClinicDayString,
} from "../src/clinic-day.js";

// America/Sao_Paulo has had no DST since 2019 -- a fixed UTC-3 offset year-round, which is
// exactly what makes every assertion below an exact equality rather than a range check.
describe("clinicDayBounds", () => {
  it("returns the UTC instants for 00:00 local on the given day and the next", () => {
    const { gte, lt } = clinicDayBounds("2026-09-28", DEFAULT_CLINIC_TIME_ZONE);
    expect(gte.toISOString()).toBe("2026-09-28T03:00:00.000Z");
    expect(lt.toISOString()).toBe("2026-09-29T03:00:00.000Z");
  });

  it("rolls a month-end day over correctly via Date.UTC's own normalization", () => {
    const { lt } = clinicDayBounds("2026-09-30", DEFAULT_CLINIC_TIME_ZONE);
    expect(lt.toISOString()).toBe("2026-10-01T03:00:00.000Z");
  });

  // 21:30 UTC on the 28th is already 18:30 *the same day* in Sao Paulo (UTC-3), and 23:30
  // UTC is 20:30 the same day too -- neither should cross into the 29th's bounds. This is
  // the exact class of bug clinic-day.ts exists to prevent: a UTC-day query would have
  // classified an early-UTC-morning exam as "yesterday" from the clinic's own point of view.
  it("a scheduledAt near UTC midnight still falls in the correct clinic-local day", () => {
    const { gte, lt } = clinicDayBounds("2026-09-28", DEFAULT_CLINIC_TIME_ZONE);
    const earlyUtc = new Date("2026-09-28T01:00:00.000Z"); // 2026-09-27T22:00 in Sao Paulo
    const lateUtc = new Date("2026-09-28T23:30:00.000Z"); // 2026-09-28T20:30 in Sao Paulo
    expect(earlyUtc >= gte && earlyUtc < lt).toBe(false); // belongs to the 27th, not the 28th
    expect(lateUtc >= gte && lateUtc < lt).toBe(true); // still the 28th
  });
});

describe("toClinicDayString / todayClinicDayString", () => {
  it("renders YYYY-MM-DD in the clinic timezone, not the machine's local zone", () => {
    // 2026-09-28T01:00:00Z is 2026-09-27 in Sao Paulo (UTC-3).
    expect(toClinicDayString(new Date("2026-09-28T01:00:00.000Z"), DEFAULT_CLINIC_TIME_ZONE)).toBe("2026-09-27");
    expect(toClinicDayString(new Date("2026-09-28T04:00:00.000Z"), DEFAULT_CLINIC_TIME_ZONE)).toBe("2026-09-28");
  });

  it("todayClinicDayString matches toClinicDayString(new Date())", () => {
    expect(todayClinicDayString(DEFAULT_CLINIC_TIME_ZONE)).toBe(toClinicDayString(new Date(), DEFAULT_CLINIC_TIME_ZONE));
  });
});

describe("formatClinicTime", () => {
  it("renders HH:mm in the clinic timezone", () => {
    expect(formatClinicTime("2026-09-28T11:00:00.000Z", DEFAULT_CLINIC_TIME_ZONE)).toBe("08:00");
  });
});

describe("clinicTimeToUtcIso / formatClinicTime round-trip", () => {
  it("a wall-clock time written and read back through the same zone matches exactly", () => {
    const iso = clinicTimeToUtcIso("2026-09-28", "08:30", DEFAULT_CLINIC_TIME_ZONE);
    expect(iso).toBe("2026-09-28T11:30:00.000Z");
    expect(formatClinicTime(iso, DEFAULT_CLINIC_TIME_ZONE)).toBe("08:30");
  });

  // The bug this module fixes: NursingPage.tsx used to write a nurse's typed time as if it
  // were UTC directly (`new Date(\`${today}T${time}:00.000Z\`)`) -- for a UTC-3 zone this is
  // 3 hours off from what clinicTimeToUtcIso now produces for the same wall-clock input.
  it("differs from the old bare-UTC construction by exactly the zone's offset", () => {
    const correct = clinicTimeToUtcIso("2026-09-28", "08:00", DEFAULT_CLINIC_TIME_ZONE);
    const oldBuggyUtc = new Date("2026-09-28T08:00:00.000Z").toISOString();
    expect(correct).not.toBe(oldBuggyUtc);
    expect(new Date(correct).getTime() - new Date(oldBuggyUtc).getTime()).toBe(3 * 60 * 60 * 1000);
  });
});
