import { describe, expect, it } from "vitest";
import { mistakes, rateText, reportText, score, SCORE_LABELS, wilson, type ScoredRow } from "@/lib/local/score";
import { EXPENSES } from "@/lib/types";

const near = (got: number | null, want: number) => expect(got).toBeCloseTo(want, 4);

describe("wilson", () => {
  // Reference values worked from the formula by hand, at z = 1.959964.
  it.each([
    [5, 10, 0.2366, 0.7634],
    [81, 263, 0.2553, 0.3662],
    [257, 460, 0.513, 0.6034],
    [6, 230, 0.012, 0.0557],
  ])("%i of %i", (k, n, lo, hi) => {
    const r = wilson(k, n);
    expect(r.p).toBe(k / n);
    near(r.lo, lo);
    near(r.hi, hi);
  });

  it("keeps a real width at none of n and all of n", () => {
    const none = wilson(0, 10);
    expect(none.lo).toBe(0);
    near(none.hi, 0.2775);
    const all = wilson(10, 10);
    near(all.lo, 0.7225);
    expect(all.hi).toBe(1);
  });

  it("gives no rate for no rows, and refuses what is not a count", () => {
    expect(wilson(0, 0)).toEqual({ k: 0, n: 0, p: null, lo: null, hi: null });
    expect(() => wilson(3, 2)).toThrow("not a count");
    expect(() => wilson(-1, 2)).toThrow("not a count");
    expect(() => wilson(1.5, 2)).toThrow("not a count");
  });

  it("is narrower with more rows at the same rate", () => {
    const small = wilson(8, 10);
    const large = wilson(80, 100);
    expect(large.hi! - large.lo!).toBeLessThan(small.hi! - small.lo!);
  });
});

let n = 0;
const row = (expect: string, got: string, more: Partial<ScoredRow> = {}): ScoredRow => ({
  id: `r${++n}`,
  expect,
  got,
  method: got === "unknown" ? "unresolved" : "keyword",
  sent: false,
  key: `k${n}`,
  confirmed: false,
  before: false,
  unsure: false,
  group: "card",
  ...more,
});

// Ten rows with every kind of outcome, small enough to count by hand.
const rows: ScoredRow[] = [
  row("medical", "medical", { confirmed: true }),
  row("medical", "medical"),
  row("medical", "unknown", { sent: true, key: "same" }), // missed, no rule matched
  row("medical", "counseling", { unsure: true }), // one cost label for another
  row("forensic_exam", "unknown", { sent: true, key: "same" }), // missed, and barred to a model
  row("transportation", "unknown", { method: "keyword" }), // missed by a rule
  row("unknown", "unknown", { method: "income", group: "money in" }),
  row("unknown", "medical", { confirmed: true, unsure: true }), // raises a claim, starts checked
  row("unknown", "dental", { before: true, confirmed: true }), // raises a claim, before the date
  row("unknown", "medical", { sent: true, method: "model" }), // raises a claim, waits for an answer
];
const s = score(rows);

describe("score", () => {
  it("counts right rows overall and on each side", () => {
    expect([s.accuracy.k, s.accuracy.n]).toEqual([3, 10]);
    expect([s.cost.k, s.cost.n]).toEqual([2, 6]);
    expect([s.none.k, s.none.n]).toEqual([1, 4]);
    expect([s.ruled.k, s.ruled.n]).toEqual([3, 7]);
    expect(s.wrong).toBe(7);
  });

  it("puts a cost label where none belongs on its own line, split by what happens next", () => {
    expect([s.overclaim.rate.k, s.overclaim.rate.n]).toEqual([3, 4]);
    expect(s.overclaim.checked).toEqual(["r8"]);
    expect(s.overclaim.before).toEqual(["r9"]);
    expect(s.overclaim.waiting).toEqual(["r10"]);
  });

  it("splits missed rows by whether a rule decided them", () => {
    expect([s.missed.rate.k, s.missed.rate.n]).toEqual([3, 6]);
    expect(s.missed.sent).toEqual(["r3", "r5"]);
    expect(s.missed.ruled).toEqual(["r6"]);
    expect(s.swapped).toEqual([{ id: "r4", expect: "medical", got: "counseling" }]);
  });

  it("counts the rows no rule matched, which is all a model is asked about", () => {
    expect(s.sent).toEqual({ rows: 3, distinct: 2, cost: 2, none: 1, barred: 1, rides: 0, left: 2 });
    expect(s.methods).toEqual({ keyword: 6, unresolved: 2, income: 1, model: 1 });
  });

  it("gives precision and recall for every label, with no rate where there is nothing to divide", () => {
    expect(s.labels.map((l) => l.label)).toEqual([...EXPENSES, "unknown"]);
    const medical = s.labels.find((l) => l.label === "medical")!;
    expect([medical.rows, medical.given, medical.right]).toEqual([4, 4, 2]);
    expect(medical.precision.p).toBe(0.5);
    expect(medical.recall.p).toBe(0.5);
    const dental = s.labels.find((l) => l.label === "dental")!;
    expect([dental.rows, dental.given, dental.right]).toEqual([0, 1, 0]);
    expect(dental.precision.p).toBe(0);
    expect(dental.recall.p).toBeNull();
    const legal = s.labels.find((l) => l.label === "legal")!;
    expect(legal.precision.p).toBeNull();
  });

  it("builds a confusion table whose cells add up to the rows", () => {
    expect(s.confusion.medical).toEqual({ medical: 2, unknown: 1, counseling: 1 });
    expect(s.confusion.unknown).toEqual({ unknown: 1, medical: 2, dental: 1 });
    const total = Object.values(s.confusion).flatMap((r) => Object.values(r));
    expect(total.reduce((a, b) => a + b, 0)).toBe(rows.length);
    expect(mistakes(s)[0]).toEqual({ expect: "unknown", got: "medical", n: 2 });
    expect(mistakes(s).reduce((a, m) => a + m.n, 0)).toBe(s.wrong);
  });

  it("counts flagged rows and groups rows by how they were written", () => {
    expect(s.unsure).toEqual({ rows: 2, wrong: 2 });
    expect(s.groups.map((g) => [g.group, g.rate.k, g.rate.n])).toEqual([
      ["card", 2, 9],
      ["money in", 1, 1],
    ]);
  });

  it("refuses a label that is not on the list", () => {
    expect(() => score([row("medical", "medicine")])).toThrow('"medicine" is not a label');
    expect(() => score([row("rent", "unknown")])).toThrow('"rent" is not a label');
    expect(SCORE_LABELS).toHaveLength(EXPENSES.length + 1);
  });
});

describe("report text", () => {
  const text = reportText(s);

  it("says each rate as a share, a count and an interval", () => {
    expect(rateText(wilson(5, 10))).toBe("50.0% (5 of 10, 95% interval 23.7% to 76.3%)");
    expect(rateText(wilson(0, 0))).toBe("no rows");
    expect(text).toContain("Accuracy: 30.0% (3 of 10, 95% interval");
  });

  it("names the rows that would raise a claim, and the count a model can add to", () => {
    expect(text).toContain("Would raise a claim (a cost label given where none belongs): 75.0% (3 of 4,");
    expect(text).toContain("on or after it, and starts checked: 1 (r8)");
    expect(text).toContain("No rule matched 3 rows (2 distinct)");
    expect(text).toContain("should get a cost label: 2. No model can add more right labels than this.");
    expect(text).toContain("1 of them are forensic_exam or lost_wages, which code never takes from a model");
    expect(text).toContain("still unsorted after this run: 2");
  });

  it("prints one line a label and a full confusion table", () => {
    const lines = text.split("\n");
    // one line in the per label table and one in the confusion table
    for (const label of SCORE_LABELS) expect(lines.filter((l) => l.startsWith(`  ${label.padEnd(22)}`)).length).toBe(2);
    expect(text).toContain("r4 medical -> counseling");
    expect(text).toContain("unknown -> medical: 2");
  });
});
