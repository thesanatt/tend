// Scores a classifier run against labeled rows: accuracy, precision and recall per label, a
// confusion table, and the mistakes that would raise a claim. A row offered as a cost when its
// label says it is not one is counted on its own line, because overclaiming is the worse error.
// No file or browser access here, so a test, a script and a page can all use it.
import { EXPENSES } from "../types";

export const NO_COST = "unknown";
export const SCORE_LABELS: readonly string[] = [...EXPENSES, NO_COST];
// Code never takes these two from a model (classify.ts, modelLabel), so a model cannot add them.
export const MODEL_BARRED: readonly string[] = ["forensic_exam", "lost_wages"];

export interface Rate {
  k: number;
  n: number;
  p: number | null; // null when there is nothing to divide by
  lo: number | null;
  hi: number | null;
}

const Z = 1.959964; // two-sided 95%

// Wilson score interval for k of n. It stays inside 0 to 1 and behaves at 0 of n and n of n,
// where the plain plus-or-minus interval collapses to a single point.
export function wilson(k: number, n: number): Rate {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || k > n) throw new Error(`not a count: ${k} of ${n}`);
  if (n === 0) return { k, n, p: null, lo: null, hi: null };
  const p = k / n;
  const z2 = Z * Z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { k, n, p, lo: k === 0 ? 0 : Math.max(0, centre - half), hi: k === n ? 1 : Math.min(1, centre + half) };
}

export interface ScoredRow {
  id: string;
  expect: string; // the label on the row: a cost label, or "unknown" for no cost
  got: string; // the cost label the run offers for the row, or "unknown"
  method: string; // how the run decided: registry, keyword, link, model, inference, unresolved, ...
  sent: boolean; // no rule matched, so this is a row a model is asked about
  key: string; // rows with the same key are sent to a model once
  confirmed: boolean; // starts checked in the flow; the rest wait for the person's answer
  before: boolean; // dated before the incident date, so the law engine leaves it out
  unsure: boolean; // the label's writer flagged it as a judgment call
  group: string; // how the row was written
}

export interface LabelScore {
  label: string;
  rows: number; // rows carrying this label
  given: number; // rows the run gave this label
  right: number;
  precision: Rate; // right of given
  recall: Rate; // right of rows
}

export interface Swap {
  id: string;
  expect: string;
  got: string;
}

export interface Score {
  rows: number;
  accuracy: Rate;
  cost: Rate; // right, among rows whose label is a cost
  none: Rate; // right, among rows whose label is no cost
  ruled: Rate; // right, among rows a rule decided
  methods: Record<string, number>;
  // Rows no rule matched: all a model is ever asked about.
  // barred: carrying a label code never takes from a model. rides: offered only on a day with a care charge.
  sent: { rows: number; distinct: number; cost: number; none: number; barred: number; rides: number; left: number };
  // A cost label given where none belongs. The rate is over rows whose label is no cost.
  overclaim: { rate: Rate; before: string[]; checked: string[]; waiting: string[] };
  // No cost label where one belongs. The rate is over rows whose label is a cost.
  missed: { rate: Rate; sent: string[]; ruled: string[] };
  swapped: Swap[]; // one cost label where another belongs
  labels: LabelScore[];
  confusion: Record<string, Record<string, number>>; // label on the row, then label given
  wrong: number;
  unsure: { rows: number; wrong: number };
  groups: { group: string; rate: Rate }[];
}

const count = <T>(rows: T[], test: (r: T) => boolean) => rows.reduce((n, r) => n + (test(r) ? 1 : 0), 0);

export function score(rows: ScoredRow[]): Score {
  for (const r of rows)
    for (const label of [r.expect, r.got])
      if (!SCORE_LABELS.includes(label)) throw new Error(`row ${r.id}: "${label}" is not a label`);
  const right = (r: ScoredRow) => r.got === r.expect;
  const rate = (of: ScoredRow[]) => wilson(count(of, right), of.length);
  const costly = rows.filter((r) => r.expect !== NO_COST);
  const plain = rows.filter((r) => r.expect === NO_COST);
  const sent = rows.filter((r) => r.sent);
  const over = plain.filter((r) => r.got !== NO_COST);
  const missed = costly.filter((r) => r.got === NO_COST);
  const ids = (of: ScoredRow[]) => of.map((r) => r.id);

  const methods: Record<string, number> = {};
  for (const r of rows) methods[r.method] = (methods[r.method] ?? 0) + 1;
  const confusion: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    confusion[r.expect] ??= {};
    confusion[r.expect][r.got] = (confusion[r.expect][r.got] ?? 0) + 1;
  }
  const groups = [...new Set(rows.map((r) => r.group))].sort();

  return {
    rows: rows.length,
    accuracy: rate(rows),
    cost: rate(costly),
    none: rate(plain),
    ruled: rate(rows.filter((r) => !r.sent)),
    methods,
    sent: {
      rows: sent.length,
      distinct: new Set(sent.map((r) => r.key)).size,
      cost: count(sent, (r) => r.expect !== NO_COST),
      none: count(sent, (r) => r.expect === NO_COST),
      barred: count(sent, (r) => MODEL_BARRED.includes(r.expect)),
      rides: count(sent, (r) => r.expect === "transportation"),
      left: count(rows, (r) => r.method === "unresolved"),
    },
    overclaim: {
      rate: wilson(over.length, plain.length),
      before: ids(over.filter((r) => r.before)),
      checked: ids(over.filter((r) => !r.before && r.confirmed)),
      waiting: ids(over.filter((r) => !r.before && !r.confirmed)),
    },
    missed: {
      rate: wilson(missed.length, costly.length),
      sent: ids(missed.filter((r) => r.sent)),
      ruled: ids(missed.filter((r) => !r.sent)),
    },
    swapped: costly
      .filter((r) => r.got !== NO_COST && !right(r))
      .map((r) => ({ id: r.id, expect: r.expect, got: r.got })),
    labels: SCORE_LABELS.map((label) => {
      const n = count(rows, (r) => r.expect === label);
      const given = count(rows, (r) => r.got === label);
      const hit = count(rows, (r) => r.expect === label && r.got === label);
      return { label, rows: n, given, right: hit, precision: wilson(hit, given), recall: wilson(hit, n) };
    }),
    confusion,
    wrong: count(rows, (r) => !right(r)),
    unsure: { rows: count(rows, (r) => r.unsure), wrong: count(rows, (r) => r.unsure && !right(r)) },
    groups: groups.map((group) => ({ group, rate: rate(rows.filter((r) => r.group === group)) })),
  };
}

export const percent = (x: number | null) => (x === null ? "n/a" : `${(100 * x).toFixed(1)}%`);

export function rateText(r: Rate): string {
  return r.n === 0
    ? "no rows"
    : `${percent(r.p)} (${r.k} of ${r.n}, 95% interval ${percent(r.lo)} to ${percent(r.hi)})`;
}

const short = (r: Rate) => (r.n === 0 ? "none" : `${percent(r.p)} [${percent(r.lo)}, ${percent(r.hi)}] ${r.k}/${r.n}`);
const listed = (ids: string[]) => (ids.length ? `${ids.length} (${ids.join(" ")})` : "0");

// Four letters a label, for the confusion table's columns.
const CODES: Record<string, string> = {
  medical: "medi",
  forensic_exam: "exam",
  counseling: "coun",
  lost_wages: "wage",
  transportation: "tran",
  relocation: "relo",
  temporary_housing: "hous",
  security: "secu",
  crime_scene_cleanup: "clea",
  childcare: "chil",
  property_replacement: "prop",
  clothing_bedding: "clot",
  prescription: "pres",
  dental: "dent",
  funeral: "fune",
  legal: "lega",
  tuition: "tuit",
  other: "othe",
  unknown: "none",
};

// The off-diagonal cells, largest first: "label on the row -> label given: count".
export function mistakes(s: Score): { expect: string; got: string; n: number }[] {
  const cells: { expect: string; got: string; n: number }[] = [];
  for (const expect of SCORE_LABELS)
    for (const got of SCORE_LABELS) {
      const n = s.confusion[expect]?.[got] ?? 0;
      if (n && expect !== got) cells.push({ expect, got, n });
    }
  return cells.sort((a, b) => b.n - a.n);
}

// The whole report as plain text, one finding a line.
export function reportText(s: Score): string {
  const out: string[] = [];
  out.push(`Rows scored: ${s.rows} (${s.cost.n} with a cost label, ${s.none.n} with none)`);
  out.push(`Accuracy: ${rateText(s.accuracy)}`);
  out.push(`  rows with a cost label: ${rateText(s.cost)}`);
  out.push(`  rows with no cost label: ${rateText(s.none)}`);
  out.push(`  rows a rule decided: ${rateText(s.ruled)}`);
  const methods = Object.entries(s.methods).sort((a, b) => b[1] - a[1]);
  out.push(`How each row was decided: ${methods.map(([m, n]) => `${m} ${n}`).join(", ")}`);
  out.push("");
  out.push(
    `No rule matched ${s.sent.rows} rows (${s.sent.distinct} distinct). A model is asked about these and no others.`,
  );
  out.push(`  should get a cost label: ${s.sent.cost}. No model can add more right labels than this.`);
  if (s.sent.barred)
    out.push(`    ${s.sent.barred} of them are ${MODEL_BARRED.join(" or ")}, which code never takes from a model`);
  if (s.sent.rides)
    out.push(`    ${s.sent.rides} of them are rides, which are offered only on a day with a care charge`);
  out.push(`  should get none: ${s.sent.none}, where a model can only add mistakes`);
  out.push(`  still unsorted after this run: ${s.sent.left}`);
  out.push("");
  out.push(`Would raise a claim (a cost label given where none belongs): ${rateText(s.overclaim.rate)}`);
  out.push(`  dated before the incident date, which the law engine leaves out: ${listed(s.overclaim.before)}`);
  out.push(`  on or after it, and starts checked: ${listed(s.overclaim.checked)}`);
  out.push(`  on or after it, and waits for an answer: ${listed(s.overclaim.waiting)}`);
  out.push(`Missed (no cost label where one belongs): ${rateText(s.missed.rate)}`);
  out.push(`  no rule matched: ${s.missed.sent.length}`);
  out.push(`  a rule called it ordinary spending, or a ride had no care that day: ${listed(s.missed.ruled)}`);
  out.push(`One cost label where another belongs: ${s.swapped.length}`);
  for (const w of s.swapped) out.push(`  ${w.id} ${w.expect} -> ${w.got}`);
  out.push("");
  out.push("Per label (precision: right of rows given the label; recall: right of rows carrying it)");
  out.push(
    `  ${"label".padEnd(22)}${"rows".padStart(5)}${"given".padStart(6)}${"right".padStart(6)}  precision / recall`,
  );
  for (const l of s.labels)
    out.push(
      `  ${l.label.padEnd(22)}${String(l.rows).padStart(5)}${String(l.given).padStart(6)}${String(l.right).padStart(6)}` +
        `  ${short(l.precision)} / ${short(l.recall)}`,
    );
  out.push("");
  out.push("Confusion (down: the label on the row; across: the label given; a dot is zero)");
  out.push(`  ${"".padEnd(22)}${SCORE_LABELS.map((l) => CODES[l].padStart(5)).join("")}`);
  for (const expect of SCORE_LABELS)
    out.push(
      `  ${expect.padEnd(22)}${SCORE_LABELS.map((got) => String(s.confusion[expect]?.[got] ?? ".").padStart(5)).join("")}`,
    );
  out.push("Mistakes, largest first");
  for (const m of mistakes(s)) out.push(`  ${m.expect} -> ${m.got}: ${m.n}`);
  out.push("");
  out.push(
    `Rows the label's writer flagged as unsure: ${s.unsure.rows}; ${s.unsure.wrong} of the ${s.wrong} wrong rows are flagged`,
  );
  out.push("By how the row was written");
  for (const g of s.groups) out.push(`  ${short(g.rate).padEnd(34)} ${g.group}`);
  return out.join("\n");
}
