// Lost pay inferred from paychecks. A check from the same payer that comes in well under the usual
// amount after the date it happened becomes a lost-pay line for the shortfall, on that deposit's
// own id; a check that never came becomes a line for the usual amount. Both are guesses about the
// survivor's own time off, so they always start unconfirmed and are asked as a question.
// The dip rule matches the API's wage_gaps (usual = the low median of at least three checks
// before the date; a dip is at least $20 and a tenth of usual). Grouping also joins descriptions
// that differ only by digits, and regular unlabeled deposits count as pay; missed checks are
// found on the device only.
import { addDays, daysBetween } from "../dates";
import { fnv64 } from "./hash";
import type { LocalClassifiedItem, LocalTxn } from "./types";

const PAY_WORDS = /payroll|salary|paycheck|direct dep|dir dep|\bwages?\b|\bpay\b/i;
const NOISE = new Set(["ppd", "ccd", "web", "ach", "id", "co", "entry", "descr", "dir", "dep", "direct", "deposit"]);
export const GAP_MIN_CENTS = 2000;
export const MIN_USUAL_CHECKS = 3;
export const PAY_GAP_REASON = "No paycheck when one usually came";

function payerKey(description: string): string {
  return description
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !NOISE.has(w))
    .join(" ");
}

// statistics.median_low: an actual value from the list, so integer cents stay integer.
export function medianLow(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[(s.length - 1) >> 1];
}

// "$236", or "$236.50" when there are cents (classify.py _dollars).
export function dollars(cents: number): string {
  const whole = Math.trunc(cents / 100).toLocaleString("en-US");
  return cents % 100 === 0 ? `$${whole}` : `$${whole}.${String(cents % 100).padStart(2, "0")}`;
}

interface Check {
  txn: LocalTxn;
  cents: number; // money in, positive
}

function payrollGroups(txns: LocalTxn[]): Map<string, Check[]> {
  const groups = new Map<string, Check[]>();
  for (const t of txns) {
    if (t.amount_cents >= 0 || (t.kind && t.kind !== "deposit")) continue;
    const key = payerKey(t.description ?? "");
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push({ txn: t, cents: -t.amount_cents });
    groups.set(key, list);
  }
  for (const [key, list] of groups) {
    list.sort((a, b) => (a.txn.date < b.txn.date ? -1 : a.txn.date > b.txn.date ? 1 : 0));
    const named = list.some((c) => PAY_WORDS.test(c.txn.description));
    const gaps = spacing(list);
    const gap = gaps.length ? medianLow(gaps) : 0;
    const regular =
      gaps.length >= 3 &&
      [7, 14, 15, 30].some((g) => Math.abs(gap - g) <= 2) &&
      gaps.filter((x) => Math.abs(x - gap) <= 3).length >= gaps.length * 0.75;
    if (!named && !(regular && list.length >= 4)) groups.delete(key);
  }
  return groups;
}

function spacing(checks: Check[]): number[] {
  return checks
    .slice(1)
    .map((c, i) => daysBetween(checks[i].txn.date, c.txn.date))
    .filter((d) => d > 0);
}

export interface PayInference {
  // Deposit id -> the lost-pay item that replaces it.
  dips: Map<string, LocalClassifiedItem>;
  // Checks that never came, each a new item.
  missed: LocalClassifiedItem[];
}

export function inferPay(txns: LocalTxn[], incidentDate: string): PayInference {
  const groups = payrollGroups(txns);
  // Where the statement ends. A bank bill's date is when it is due, which can be weeks later.
  const lastDay = txns.reduce((max, t) => (t.kind !== "bill" && t.date > max ? t.date : max), "");
  const dips = new Map<string, LocalClassifiedItem>();
  const missed: LocalClassifiedItem[] = [];
  for (const [key, checks] of groups) {
    const before = checks.filter((c) => c.txn.date < incidentDate);
    if (before.length < MIN_USUAL_CHECKS) continue; // not enough history to know what usual is
    const usual = medianLow(before.map((c) => c.cents));
    const gaps = spacing(checks);
    const gap = gaps.length ? medianLow(gaps) : 7;
    const weeks = Math.max(1, Math.round(gap / 7));
    const base = { expense: "lost_wages" as const, confirmed: false, insurance_paid_cents: 0, is_bill: false };
    const shape = { unit: "week" as const, units: weeks, tags: [], source: "rule" as const, method: "inference" };

    for (const c of checks) {
      const short = usual - c.cents;
      if (c.txn.date < incidentDate || short < GAP_MIN_CENTS || short * 10 < usual) continue;
      dips.set(c.txn.id, {
        item_id: c.txn.id,
        date: c.txn.date,
        amount_cents: short,
        ...base,
        ...shape,
        description: [c.txn.merchant, c.txn.description].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 200),
        reason: `Paycheck was ${dollars(c.cents)}, ${dollars(short)} below your usual ${dollars(usual)}`,
        confidence: 0.6,
        linked_item_ids: [],
      });
    }

    // Checks that never came: due on the usual schedule after the last one before the date, up
    // to a few days before the statement ends, and before another payer's first check after it.
    if (gap < 6) continue;
    const otherStart = [...groups.entries()]
      .filter(([k]) => k !== key)
      .flatMap(([, list]) => list.map((c) => c.txn.date))
      .filter((d) => d >= incidentDate)
      .sort()[0];
    const endOfData = addDays(lastDay, -3);
    const beforeOther = otherStart ? addDays(otherStart, -1) : endOfData;
    const stop = beforeOther < endOfData ? beforeOther : endOfData;
    const tolerance = Math.ceil(gap / 3);
    const payer = checks[checks.length - 1].txn.description.replace(/\s+/g, " ").trim();
    let expected = addDays(before[before.length - 1].txn.date, gap);
    for (let n = 0; n < 60 && expected <= stop; n++, expected = addDays(expected, gap)) {
      if (expected < incidentDate) continue;
      if (checks.some((c) => Math.abs(daysBetween(expected, c.txn.date)) <= tolerance)) continue;
      missed.push({
        item_id: `paygap:${fnv64(key)}:${expected}`,
        date: expected,
        amount_cents: usual,
        ...base,
        ...shape,
        description: `${payer}: no paycheck near this date`.slice(0, 200),
        reason: PAY_GAP_REASON,
        confidence: 0.5,
        linked_item_ids: [],
      });
    }
  }
  missed.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.item_id < b.item_id ? -1 : 1));
  return { dips, missed };
}

// Every lost-pay line, dips and missed checks, in date order.
export function inferPayDips(txns: LocalTxn[], incidentDate: string): LocalClassifiedItem[] {
  const { dips, missed } = inferPay(txns, incidentDate);
  return [...dips.values(), ...missed].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.item_id < b.item_id ? -1 : 1,
  );
}
