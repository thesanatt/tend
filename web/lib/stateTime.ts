// Today in a state's own time: the law engine's as_of_date (docs/SPEC.md v1.3). Where a state spans
// several zones, the westernmost one, whose date turns last, so a late night anywhere in the state never
// counts a filing deadline a day early. api/tend_api/clock.py holds the same table, and
// api/tests/test_state_time.py keeps the two equal.
import { todayIso } from "./dates";

export const STATE_TIME_ZONES: Record<string, string> = {
  AK: "America/Adak",
  AL: "America/Chicago",
  AR: "America/Chicago",
  AZ: "America/Phoenix",
  CA: "America/Los_Angeles",
  CO: "America/Denver",
  CT: "America/New_York",
  DC: "America/New_York",
  DE: "America/New_York",
  FL: "America/Chicago",
  GA: "America/New_York",
  HI: "Pacific/Honolulu",
  IA: "America/Chicago",
  ID: "America/Los_Angeles",
  IL: "America/Chicago",
  IN: "America/Chicago",
  KS: "America/Denver",
  KY: "America/Chicago",
  LA: "America/Chicago",
  MA: "America/New_York",
  MD: "America/New_York",
  ME: "America/New_York",
  MI: "America/Menominee",
  MN: "America/Chicago",
  MO: "America/Chicago",
  MS: "America/Chicago",
  MT: "America/Denver",
  NC: "America/New_York",
  ND: "America/Denver",
  NE: "America/Denver",
  NH: "America/New_York",
  NJ: "America/New_York",
  NM: "America/Denver",
  NV: "America/Los_Angeles",
  NY: "America/New_York",
  OH: "America/New_York",
  OK: "America/Chicago",
  OR: "America/Los_Angeles",
  PA: "America/New_York",
  RI: "America/New_York",
  SC: "America/New_York",
  SD: "America/Denver",
  TN: "America/Chicago",
  TX: "America/Denver",
  UT: "America/Denver",
  VA: "America/New_York",
  VT: "America/New_York",
  WA: "America/Los_Angeles",
  WI: "America/Chicago",
  WV: "America/New_York",
  WY: "America/Denver",
};

// Standard time offsets in hours, for a browser that cannot name the zone. Standard time is never
// ahead of the local clock, so this can only count a deadline late, never early.
export const STANDARD_OFFSET_HOURS: Record<string, number> = {
  "America/New_York": -5,
  "America/Chicago": -6,
  "America/Menominee": -6,
  "America/Denver": -7,
  "America/Phoenix": -7,
  "America/Los_Angeles": -8,
  "America/Adak": -10,
  "Pacific/Honolulu": -10,
};

function dayIn(zone: string, now: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const day = `${part("year")}-${part("month")}-${part("day")}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  } catch {
    // An unknown zone name: fall through to standard time.
  }
  return new Date(now.getTime() + STANDARD_OFFSET_HOURS[zone] * 3_600_000).toISOString().slice(0, 10);
}

// The device's own date until a state is chosen, or for anything that is not one of the 51.
export function stateToday(st: string | null | undefined, now: Date = new Date()): string {
  const zone = STATE_TIME_ZONES[(st ?? "").toUpperCase()];
  return zone ? dayIn(zone, now) : todayIso(now);
}
