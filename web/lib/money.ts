// Integer cents in, display strings out. No floating point touches an amount.

export function assertCents(value: number, label = "amount"): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be integer cents, got ${value}`);
  return value;
}

export function formatCents(cents: number): string {
  assertCents(cents);
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rest = (abs % 100).toString().padStart(2, "0");
  return `${cents < 0 ? "-" : ""}$${dollars}.${rest}`;
}

// "$1,394" when the cents are zero, for headings where the extra ".00" is noise.
export function formatCentsShort(cents: number): string {
  const full = formatCents(cents);
  return full.endsWith(".00") ? full.slice(0, -3) : full;
}

export function sumCents(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += assertCents(v);
  return assertCents(total, "total");
}

// Reads "12.5", "$1,200.00", "40" as cents. Returns null for anything else.
export function parseDollars(text: string): number | null {
  const m = text
    .trim()
    .replace(/[$,\s]/g, "")
    .match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}
