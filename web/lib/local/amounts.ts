// Money and dates as they appear in statements and bills. Amounts become integer cents by reading
// the digits as text; no floating point touches an amount.
import { pyRegex } from "./pytext";

// api/tend_api/money.py: "$1,171.75", "325.00", "(12.50)", "-12.50", "$443". Cents are exactly two digits.
const PY_MONEY = pyRegex(
  String.raw`^(?<open>\()?\s*(?<neg>-)?\s*\$?\s*(?<whole>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?<frac>\d{2}))?\s*(?<close>\))?$`,
  "",
);
export const MONEY_TOKEN_SOURCE = String.raw`\(?-?\$?\s?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\)?|\(?-?\$\s?(?:\d{1,3}(?:,\d{3})+|\d+)\)?`;

function cents(whole: string, frac: string): number | null {
  const value = Number(whole.replace(/,/g, "")) * 100 + Number(frac.padEnd(2, "0") || "0");
  return Number.isSafeInteger(value) ? value : null;
}

// money.py parse_cents: throws on anything that is not a money amount.
export function parseCents(text: string): number {
  const m = PY_MONEY.exec(text.trim());
  if (!m || Boolean(m.groups!.open) !== Boolean(m.groups!.close))
    throw new Error(`not a money amount: ${JSON.stringify(text)}`);
  const value = cents(m.groups!.whole, m.groups!.frac ?? "");
  if (value === null) throw new Error(`amount too large: ${JSON.stringify(text)}`);
  return m.groups!.neg || m.groups!.open ? -value : value;
}

export interface ParsedAmount {
  cents: number; // magnitude, never negative
  negative: boolean; // a minus sign, a trailing minus, or parentheses
  explicit: boolean; // the text carried a sign of either kind
  marker: "cr" | "dr" | null; // a CR or DR suffix
}

const PLAIN = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$|^\.(\d{1,2})$/;

// Statement amounts: "$1,234.56", "-12.34", "(12.34)", "12.34-", "+5", "12.34 CR", "USD 9.5".
// Up to two decimals (spreadsheets often drop a trailing zero). Returns null for anything else.
export function parseAmount(raw: string | null | undefined): ParsedAmount | null {
  let s = (raw ?? "").trim().replace(/\u2212/g, "-");
  if (!s) return null;
  let marker: ParsedAmount["marker"] = null;
  const suffix = /\s*(CR|DR)\.?$/i.exec(s);
  if (suffix) {
    marker = suffix[1].toLowerCase() as "cr" | "dr";
    s = s.slice(0, suffix.index).trim();
  }
  let negative = false;
  let explicit = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    explicit = true;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^(?:USD|US\$)\s*/i, "").replace(/\s*USD$/i, "");
  if (s.startsWith("+")) {
    explicit = true;
    s = s.slice(1).trim();
  } else if (s.startsWith("-")) {
    negative = !negative;
    explicit = true;
    s = s.slice(1).trim();
  } else if (s.endsWith("-")) {
    negative = !negative;
    explicit = true;
    s = s.slice(0, -1).trim();
  }
  if (s.startsWith("$")) s = s.slice(1).trim();
  if (s.startsWith("-")) {
    if (explicit) return null; // two signs, as in "--5"
    negative = !negative;
    explicit = true;
    s = s.slice(1).trim();
  }
  const m = PLAIN.exec(s);
  if (!m) return null;
  const value = m[3] !== undefined ? cents("0", m[3]) : cents(m[1], m[2] ?? "");
  if (value === null) return null;
  return { cents: value, negative: value === 0 ? false : negative, explicit, marker };
}

// Signed cents with the text's own sign: "-12.34" -> -1234.
export function signedCents(raw: string | null | undefined): number | null {
  const a = parseAmount(raw);
  return a ? (a.negative ? -a.cents : a.cents) : null;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

export function monthNumber(name: string): number | null {
  const key = name.toLowerCase().replace(/\.$/, "");
  if (MONTHS[key]) return MONTHS[key];
  const short = key.slice(0, 3);
  const full = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  return full.includes(key) ? MONTHS[short] : null;
}

export function isoDay(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const fullYear = (y: string) => (y.length <= 2 ? 2000 + Number(y) : Number(y));

export type DateOrder = "mdy" | "dmy";

// One date as a bank writes it. Numeric dates are month first unless the column says otherwise.
export function parseDate(raw: string | null | undefined, order: DateOrder = "mdy"): string | null {
  const s = (raw ?? "").trim().replace(/^"|"$/g, "");
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return isoDay(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{4})(\d{2})(\d{2})(?:\d{0,6}(?:\.\d+)?)?(?:\[.*\])?$/.exec(s); // OFX: 20260614120000[-5:EST]
  if (m) return isoDay(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s.*)?$/.exec(s);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return order === "dmy" ? isoDay(fullYear(m[3]), b, a) : isoDay(fullYear(m[3]), a, b);
  }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s); // Jun 14, 2026
  if (m && monthNumber(m[1])) return isoDay(Number(m[3]), monthNumber(m[1])!, Number(m[2]));
  m = /^(\d{1,2})[\s-]([A-Za-z]{3,9})\.?[\s-](\d{2}|\d{4})$/.exec(s); // 14 Jun 2026, 14-Jun-26
  if (m && monthNumber(m[2])) return isoDay(fullYear(m[3]), monthNumber(m[2])!, Number(m[1]));
  return null;
}

// Picks month-first or day-first for a column: day-first only when some value cannot be month-first.
export function detectDateOrder(values: string[]): DateOrder {
  let mdy = 0;
  let dmy = 0;
  for (const v of values) {
    if (parseDate(v, "mdy")) mdy++;
    if (parseDate(v, "dmy")) dmy++;
  }
  return dmy > mdy ? "dmy" : "mdy";
}
