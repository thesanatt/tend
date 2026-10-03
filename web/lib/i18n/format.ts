// Dates, spans, and counts in the survivor's language. Money stays integer cents and US format in both.
import { formatCents } from "../money";

export type Lang = "en" | "es";

export const LANGS: readonly Lang[] = ["en", "es"];

const LOCALE: Record<Lang, string> = { en: "en-US", es: "es-US" };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function day(iso: string): Date {
  if (!ISO_DAY.test(iso)) throw new Error(`not an ISO day: ${iso}`);
  return new Date(`${iso}T00:00:00Z`);
}

export function formatDate(iso: string, lang: Lang, style: "long" | "short" | "numeric" = "long"): string {
  const opts: Intl.DateTimeFormatOptions =
    style === "long"
      ? { year: "numeric", month: "long", day: "numeric" }
      : style === "short"
        ? { month: "short", day: "numeric" }
        : { year: "numeric", month: "2-digit", day: "2-digit" };
  return new Intl.DateTimeFormat(LOCALE[lang], { ...opts, timeZone: "UTC" }).format(day(iso));
}

export function formatTime(ts: string, lang: Lang): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return new Intl.DateTimeFormat(LOCALE[lang], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

export const formatMoney = formatCents;

// "$1,394" when the cents are zero, for sentences where ".00" is noise.
export function formatMoneyShort(cents: number): string {
  const full = formatCents(cents);
  return full.endsWith(".00") ? full.slice(0, -3) : full;
}

const UNITS: Record<Lang, { year: [string, string]; month: [string, string]; day: [string, string] }> = {
  en: { year: ["year", "years"], month: ["month", "months"], day: ["day", "days"] },
  es: { year: ["año", "años"], month: ["mes", "meses"], day: ["día", "días"] },
};

export function count(n: number, [one, many]: [string, string]): string {
  return `${n} ${n === 1 ? one : many}`;
}

// "4 years, 8 months" between two days. Returns null when the end is before the start.
export function describeSpan(fromIso: string, toIso: string, lang: Lang): string | null {
  const a = day(fromIso);
  const b = day(toIso);
  if (b < a) return null;
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  const u = UNITS[lang];
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const parts: string[] = [];
  if (years) parts.push(count(years, u.year));
  if (rest) parts.push(count(rest, u.month));
  if (!parts.length) return count(Math.round((b.getTime() - a.getTime()) / 86_400_000), u.day);
  return parts.join(lang === "es" ? " y " : ", ");
}

export function listJoin(items: string[], lang: Lang): string {
  return new Intl.ListFormat(LOCALE[lang], { style: "long", type: "conjunction" }).format(items);
}

export function orJoin(items: string[], lang: Lang): string {
  return new Intl.ListFormat(LOCALE[lang], { style: "long", type: "disjunction" }).format(items);
}
