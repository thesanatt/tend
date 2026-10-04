// Today in a state's own time: the law engine's as_of_date (docs/SPEC.md v1.3). The state's westernmost
// zone, whose date turns last, so a late night anywhere in the state never counts a filing deadline a
// day early. A device whose own date is one the state is on right now keeps it: just after midnight in
// Detroit, Michigan's Central time counties are still on yesterday, but a survivor in Detroit can enter
// today's date and today's bills. api/tend_api/clock.py holds the same westernmost table, and
// api/tests/test_state_time.py keeps the two equal and checks the eastern one below.
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

// For the states that span several zones, the one whose date turns first. Every other state has one.
export const STATE_EAST_TIME_ZONES: Record<string, string> = {
  AK: "America/Anchorage",
  AZ: "America/Denver", // the Navajo Nation keeps daylight time
  FL: "America/New_York",
  ID: "America/Boise",
  IN: "America/Indiana/Indianapolis",
  KS: "America/Chicago",
  KY: "America/Kentucky/Louisville",
  MI: "America/Detroit",
  ND: "America/Chicago",
  NE: "America/Chicago",
  NV: "America/Denver", // West Wendover
  OR: "America/Boise",
  SD: "America/Chicago",
  TN: "America/New_York",
  TX: "America/Chicago",
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

function zoneDay(zone: string, now: Date): string | null {
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
    // An unknown zone name.
  }
  return null;
}

function dayIn(zone: string, now: Date): string {
  // A zone the browser cannot name: standard time.
  return (
    zoneDay(zone, now) ?? new Date(now.getTime() + STANDARD_OFFSET_HOURS[zone] * 3_600_000).toISOString().slice(0, 10)
  );
}

// The device's own date until a state is chosen, or for anything that is not one of the 51. For a
// state, the device's date when the state is on that date right now, else the westernmost date.
// `device` is the device's date, given only by tests.
export function stateToday(st: string | null | undefined, now: Date = new Date(), device = todayIso(now)): string {
  const code = (st ?? "").toUpperCase();
  const zone = STATE_TIME_ZONES[code];
  if (!zone) return device;
  const west = dayIn(zone, now);
  const eastZone = STATE_EAST_TIME_ZONES[code];
  // Without the eastern zone, only the westernmost date is known to be one the state is on.
  const east = eastZone ? (zoneDay(eastZone, now) ?? west) : west;
  return device >= west && device <= east ? device : west;
}
