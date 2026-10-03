// Lost pay inferred from paychecks: a check after the date that is clearly below the usual amount,
// or a check that never came. These are guesses about the survivor's own time off, so they always
// start unconfirmed and are asked as "Did you miss this work to recover or get care?".
import { formatCents } from "../money";
import { addDays, daysBetween } from "../dates";
import { fnv64 } from "./hash";
import type { LocalClassifiedItem, LocalTxn } from "./types";

const PAY_WORDS = /payroll|direct dep|dir dep|salary|wages|paycheck|\bpay\b/i;
const NOISE = new Set([
  "ppd",
  "ccd",
  "web",
  "ach",
  "id",
  "co",
  "entry",
  "descr",
  "dir",
  "dep",
  "direct",
  "deposit",
  "payroll",
  "pay",
  "inc",
  "llc",
]);

export const PAY_DIP_REASON = "Paycheck lower than your usual pay";
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

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  if (s.length % 2) return s[mid];
  const sum = s[mid - 1] + s[mid];
  return (sum - (sum % 2)) / 2; // integer cents, rounded down
}

interface Check {
  txn: LocalTxn;
  cents: number; // money in, positive
}

function payrollGroups(txns: LocalTxn[]): Map<string, Check[]> {
  const groups = new Map<string, Check[]>();
  for (const t of txns) {
    if (t.amount_cents >= 0 || (t.kind && t.kind !== "deposit")) continue;
    const key = payerKey(t.description);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push({ txn: t, cents: -t.amount_cents });
    groups.set(key, list);
  }
  for (const [key, list] of groups) {
    list.sort((a, b) => (a.txn.date < b.txn.date ? -1 : a.txn.date > b.txn.date ? 1 : 0));
    const named = list.some((c) => PAY_WORDS.test(c.txn.description));
    const gaps = list.slice(1).map((c, i) => daysBetween(list[i].txn.date, c.txn.date));
    const gap = gaps.length ? median(gaps) : 0;
    const regular =
      gaps.length >= 3 &&
      [7, 14, 15, 30].some((g) => Math.abs(gap - g) <= 2) &&
      gaps.filter((x) => Math.abs(x - gap) <= 3).length >= gaps.length * 0.75;
    if (!(named && list.length >= 3) && !(regular && list.length >= 4)) groups.delete(key);
  }
  return groups;
}

export function inferPayDips(txns: LocalTxn[], incidentDate: string): LocalClassifiedItem[] {
  const groups = payrollGroups(txns);
  const lastDay = txns.reduce((max, t) => (t.date > max ? t.date : max), "");
  const items: LocalClassifiedItem[] = [];
  for (const [key, checks] of groups) {
    const before = checks.filter((c) => c.txn.date < incidentDate);
    const after = checks.filter((c) => c.txn.date >= incidentDate && daysBetween(incidentDate, c.txn.date) <= 366);
    if (before.length < 2) continue; // not enough history to know the usual amount
    const usual = median(before.map((c) => c.cents));
    const gaps = checks.slice(1).map((c, i) => daysBetween(checks[i].txn.date, c.txn.date));
    const gap = median(gaps);
    const weeks = Math.min(5, Math.max(1, Math.round(gap / 7)));
    const payer = checks[checks.length - 1].txn.description.replace(/\s+/g, " ").trim();

    for (const c of after) {
      const dip = usual - c.cents;
      // At least 10 percent and $20 below the usual check.
      if (dip < 2000 || c.cents * 10 > usual * 9) continue;
      items.push({
        item_id: `paydip:${c.txn.id}`,
        date: c.txn.date,
        amount_cents: dip,
        expense: "lost_wages",
        confirmed: false,
        insurance_paid_cents: 0,
        is_bill: false,
        units: weeks,
        unit: "week",
        tags: [],
        description: `${payer}: ${formatCents(c.cents)} paid, usually ${formatCents(usual)}`.slice(0, 200),
        source: "rule",
        reason: PAY_DIP_REASON,
        confidence: 0.6,
        method: "pay_dip",
        linked_item_ids: [c.txn.id],
      });
    }

    // Checks that never came: expected on the usual schedule after the last one before the date,
    // up to a few days before the statement ends, and not after another employer's pay starts.
    if (gap < 6) continue;
    const otherStart = [...groups.entries()]
      .filter(([k]) => k !== key)
      .flatMap(([, list]) => list.map((c) => c.txn.date))
      .filter((d) => d >= incidentDate)
      .sort()[0];
    // The last day a missing check can be due: a few days before the statement ends, and before
    // another employer's first check after the date.
    const endOfData = addDays(lastDay, -3);
    const beforeOther = otherStart ? addDays(otherStart, -1) : endOfData;
    const stop = beforeOther < endOfData ? beforeOther : endOfData;
    const tolerance = Math.ceil(gap / 3);
    let expected = addDays(before[before.length - 1].txn.date, gap);
    for (let n = 0; n < 60 && expected <= stop; n++, expected = addDays(expected, gap)) {
      if (expected < incidentDate) continue;
      const arrived = checks.some((c) => Math.abs(daysBetween(expected, c.txn.date)) <= tolerance);
      if (arrived) continue;
      items.push({
        item_id: `paygap:${fnv64(key)}:${expected}`,
        date: expected,
        amount_cents: usual,
        expense: "lost_wages",
        confirmed: false,
        insurance_paid_cents: 0,
        is_bill: false,
        units: weeks,
        unit: "week",
        tags: [],
        description: `${payer}: no paycheck near this date, usually ${formatCents(usual)}`.slice(0, 200),
        source: "rule",
        reason: PAY_GAP_REASON,
        confidence: 0.5,
        method: "pay_gap",
        linked_item_ids: [],
      });
    }
  }
  return items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.item_id < b.item_id ? -1 : 1));
}
