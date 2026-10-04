// Dates are ISO calendar days ("2026-06-14"). All math runs in UTC so no time zone shifts a day.

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function toDate(iso: string): Date {
  if (!isIsoDay(iso)) throw new Error(`not an ISO day: ${iso}`);
  return new Date(`${iso}T00:00:00Z`);
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// The calendar day on this device of a moment such as "2026-10-04T01:20:00Z" (a payment's time, in UTC),
// so a payment made at 9 PM in Michigan is that day, not the next. An ISO day is returned as is.
export function localDay(stamp: string): string {
  if (isIsoDay(stamp)) return stamp;
  const d = new Date(stamp);
  return Number.isNaN(d.getTime()) ? stamp.slice(0, 10) : todayIso(d);
}

// Calendar years; Feb 29 lands on Feb 28 in a non-leap year.
export function addYears(iso: string, years: number): string {
  const d = toDate(iso);
  const month = d.getUTCMonth();
  const target = new Date(Date.UTC(d.getUTCFullYear() + years, month, d.getUTCDate()));
  if (target.getUTCMonth() !== month) target.setUTCDate(0);
  return toIso(target);
}

export function addDays(iso: string, days: number): string {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

export function daysBetween(fromIso: string, toIsoDay: string): number {
  return Math.round((toDate(toIsoDay).getTime() - toDate(fromIso).getTime()) / 86_400_000);
}

export function formatDay(iso: string, style: "long" | "short" | "numeric" = "long"): string {
  const opts: Intl.DateTimeFormatOptions =
    style === "long"
      ? { year: "numeric", month: "long", day: "numeric" }
      : style === "short"
        ? { month: "short", day: "numeric" }
        : { year: "numeric", month: "2-digit", day: "2-digit" };
  return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(toDate(iso));
}

export function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
}

// "4 years, 8 months" between two days, for deadlines.
export function describeSpan(fromIso: string, toIsoDay: string): string {
  const a = toDate(fromIso);
  const b = toDate(toIsoDay);
  if (b < a) return "past";
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const parts: string[] = [];
  if (years) parts.push(`${years} year${years === 1 ? "" : "s"}`);
  if (rest) parts.push(`${rest} month${rest === 1 ? "" : "s"}`);
  if (!parts.length) {
    const days = daysBetween(fromIso, toIsoDay);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  return parts.join(", ");
}
