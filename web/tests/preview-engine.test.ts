// Checks lib/engine/preview.ts against each numbered step of docs/SPEC.md "Law engine semantics".
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluatePreview } from "@/lib/engine/preview";
import type { EngineInput, EngineItem, Jurisdiction, Rule, RuleCategory, RuleParams } from "@/lib/types";

const rule = (id: string, category: RuleCategory, params: RuleParams = {}, expense?: string): Rule => ({
  id,
  category,
  expense: expense ?? null,
  params,
  summary: id,
  quote: id,
  source_id: "T-S1",
  pinpoint: `Sec. ${id}`,
});

const law = (rules: Rule[]): Jurisdiction => ({
  jurisdiction: "TS",
  name: "Testland",
  program: { program_name: "Test", agency: "Test agency", website: "https://example.org" },
  sources: [],
  rules,
  coverage: { found: [], not_found: [] },
  confidence: "high",
});

let n = 0;
const item = (over: Partial<EngineItem>): EngineItem => ({
  item_id: `i${String(++n).padStart(3, "0")}`,
  date: "2026-06-20",
  amount_cents: 10000,
  expense: "medical",
  confirmed: true,
  insurance_paid_cents: 0,
  is_bill: false,
  units: 0,
  description: "test",
  ...over,
});

const input = (items: EngineItem[], ctx: Partial<EngineInput["context"]> = {}): EngineInput => ({
  jurisdiction: "TS",
  context: {
    incident_date: "2026-06-14",
    as_of_date: "2026-10-03",
    police_report: "unknown",
    forensic_exam: false,
    ...ctx,
  },
  items,
});

const MEDICAL = rule("COV-MED", "covered_expense", { expense: "medical" });
const run = (rules: Rule[], items: EngineItem[], ctx?: Partial<EngineInput["context"]>) =>
  evaluatePreview(input(items, ctx), law(rules), "sha");
const lineOf = (out: ReturnType<typeof run>, id: string) => out.lines.find((l) => l.item_id === id)!;

describe("per-item decisions", () => {
  it("1. drops items outside the window", () => {
    const before = item({ date: "2026-06-13" });
    const after = item({ date: "2026-10-04" });
    const inside = item({ date: "2026-06-14" });
    const out = run([MEDICAL], [before, after, inside]);
    expect(lineOf(out, before.item_id).status).toBe("out_of_window");
    expect(lineOf(out, after.item_id).status).toBe("out_of_window");
    expect(lineOf(out, inside.item_id).status).toBe("eligible");
    expect(out.totals.allowed_cents).toBe(10000);
  });

  it("2. holds a forensic exam bill with every exam rule as proof", () => {
    const exam = item({ expense: "forensic_exam", amount_cents: 32500, is_bill: true });
    const out = run(
      [
        rule("NB-1", "exam_no_bill", {}, "forensic_exam"),
        rule("PAY-1", "exam_payment", { payer: "State" }, "forensic_exam"),
        MEDICAL,
      ],
      [exam],
    );
    const line = lineOf(out, exam.item_id);
    expect(line.status).toBe("held");
    expect(line.rule_ids).toEqual(["NB-1", "PAY-1"]);
    expect(line.allowed_cents).toBe(0);
    expect(out.totals.held_cents).toBe(32500);
    expect(out.totals.allowed_cents).toBe(0);
  });

  it("2. holds with only an exam_payment rule", () => {
    const exam = item({ expense: "forensic_exam" });
    const out = run([rule("PAY-1", "exam_payment", {}, "forensic_exam")], [exam]);
    expect(lineOf(out, exam.item_id)).toMatchObject({ status: "held", rule_ids: ["PAY-1"] });
  });

  it("2. treats the exam as medical when the state has no exam rule", () => {
    const exam = item({ expense: "forensic_exam" });
    const line = lineOf(run([MEDICAL], [exam]), exam.item_id);
    expect(line).toMatchObject({ status: "eligible", expense: "medical", rule_ids: ["COV-MED"], flags: [] });
  });

  it("3. excludes an expense the law excludes, before asking for confirmation", () => {
    const phone = item({ expense: "property_replacement", confirmed: false });
    const out = run(
      [
        rule("EX-1", "excluded_expense", { expense: "property_replacement" }),
        rule("EX-2", "excluded_expense", { item: "pain" }),
      ],
      [phone],
    );
    expect(lineOf(out, phone.item_id)).toMatchObject({ status: "excluded", rule_ids: ["EX-1"], allowed_cents: 0 });
  });

  it("3. reads a rule's expense the way both engines do (refengine reading 1)", () => {
    const care = item({ expense: "medical" });
    const rides = item({ expense: "transportation" });
    const rx = item({ expense: "prescription" });
    const covered = [
      MEDICAL,
      rule("COV-T", "covered_expense", { expense: "transportation" }),
      rule("COV-RX", "covered_expense", { expense: "prescription" }),
    ];
    // A top-level expense names that expense even when params.item narrows it in words.
    const named = {
      ...rule("EX-MED", "excluded_expense", { item: "services covered by Medicaid" }),
      expense: "medical",
    };
    // rule.expense wins over params.expense.
    const both = { ...rule("EX-T", "excluded_expense", { expense: "prescription" }), expense: "transportation" };
    // Item text alone names no expense.
    const textOnly = rule("EX-TXT", "excluded_expense", { item: "prescription drugs" });
    const out = run([...covered, named, both, textOnly], [care, rides, rx]);
    expect(lineOf(out, care.item_id)).toMatchObject({ status: "excluded", rule_ids: ["EX-MED"] });
    expect(lineOf(out, rides.item_id)).toMatchObject({ status: "excluded", rule_ids: ["EX-T"] });
    expect(lineOf(out, rx.item_id)).toMatchObject({ status: "eligible", rule_ids: ["COV-RX"] });
  });

  it("4. leaves out costs no verified rule names, and unknown expenses", () => {
    const rx = item({ expense: "prescription" });
    const odd = item({ expense: "unknown" });
    const out = run([MEDICAL], [rx, odd]);
    expect(lineOf(out, rx.item_id)).toMatchObject({ status: "unknown_rule", rule_ids: [] });
    expect(lineOf(out, odd.item_id).status).toBe("unknown_rule");
  });

  it("4. an expense_cap alone is enough to name an expense", () => {
    const lock = item({ expense: "security" });
    const out = run(
      [rule("CAP-SEC", "expense_cap", { expense: "security", amount_cents: 100000, per: "claim" })],
      [lock],
    );
    expect(lineOf(out, lock.item_id)).toMatchObject({ status: "eligible", rule_ids: ["CAP-SEC"] });
  });

  it("5. counts nothing until the survivor confirms", () => {
    const ride = item({ expense: "transportation", confirmed: false });
    const out = run([rule("COV-T", "covered_expense", { expense: "transportation" })], [ride]);
    expect(lineOf(out, ride.item_id)).toMatchObject({
      status: "needs_confirmation",
      rule_ids: ["COV-T"],
      allowed_cents: 0,
    });
    expect(out.totals.allowed_cents).toBe(0);
  });

  it("6. nets insurance out when a collateral rule exists, never below zero", () => {
    const a = item({ amount_cents: 10000, insurance_paid_cents: 2500 });
    const b = item({ amount_cents: 10000, insurance_paid_cents: 15000 });
    const out = run([MEDICAL, rule("COLL-1", "collateral_source")], [a, b]);
    expect(lineOf(out, a.item_id)).toMatchObject({ allowed_cents: 7500, rule_ids: ["COV-MED", "COLL-1"] });
    expect(lineOf(out, b.item_id).allowed_cents).toBe(0);
  });

  it("6. ignores insurance when the state has no collateral rule", () => {
    const a = item({ amount_cents: 10000, insurance_paid_cents: 2500 });
    expect(lineOf(run([MEDICAL], [a]), a.item_id).allowed_cents).toBe(10000);
  });
});

describe("aggregate phase", () => {
  it("7. cuts the item that crosses a per-claim cap and zeroes later ones", () => {
    const items = [1, 2, 3].map((d) => item({ expense: "transportation", amount_cents: 60000, date: `2026-07-0${d}` }));
    const out = run(
      [
        rule("COV-T", "covered_expense", { expense: "transportation" }),
        rule("CAP-T", "expense_cap", { expense: "transportation", amount_cents: 100000, per: "claim" }),
      ],
      items,
    );
    expect(items.map((i) => lineOf(out, i.item_id).allowed_cents)).toEqual([60000, 40000, 0]);
    expect(items.map((i) => lineOf(out, i.item_id).cap_rule_id)).toEqual([null, "CAP-T", "CAP-T"]);
    expect(out.totals).toMatchObject({ requested_cents: 180000, allowed_cents: 100000 });
    expect(out.totals.by_expense.transportation).toBe(100000);
  });

  it("7. applies per-unit caps by units and flags lines without units", () => {
    const wages = item({ expense: "lost_wages", amount_cents: 250000, units: 2 });
    const unknownWeeks = item({ expense: "lost_wages", amount_cents: 50000, units: 0 });
    const out = run(
      [
        rule("COV-W", "covered_expense", { expense: "lost_wages" }),
        rule("CAP-W", "expense_cap", { expense: "lost_wages", amount_cents: 100000, per: "week" }),
      ],
      [wages, unknownWeeks],
    );
    expect(lineOf(out, wages.item_id)).toMatchObject({ allowed_cents: 200000, cap_rule_id: "CAP-W" });
    expect(lineOf(out, unknownWeeks.item_id)).toMatchObject({ allowed_cents: 50000, cap_rule_id: null });
    expect(lineOf(out, unknownWeeks.item_id).flags).toContain("rate_unverified:CAP-W");
  });

  it("8. walks all eligible items against the smallest total cap", () => {
    const items = [item({ amount_cents: 300000 }), item({ amount_cents: 300000, date: "2026-06-21" })];
    const out = run(
      [
        MEDICAL,
        rule("TOT-1", "total_cap", { amount_cents: 1000000 }),
        rule("TOT-2", "total_cap", { amount_cents: 450000 }),
      ],
      items,
    );
    expect(items.map((i) => lineOf(out, i.item_id).allowed_cents)).toEqual([300000, 150000]);
    expect(lineOf(out, items[1].item_id).cap_rule_id).toBe("TOT-2");
    expect(out.totals.allowed_cents).toBe(450000);
  });

  it("9. checks minimum loss: met, not met, waived, days-only, none", () => {
    const min = (p: RuleParams) => [MEDICAL, rule("MIN-1", "minimum_loss", p)];
    const small = () => [item({ amount_cents: 5000 })];
    expect(run(min({ amount_cents: 2500 }), small()).checks.minimum_loss).toEqual({
      status: "met",
      rule_ids: ["MIN-1"],
    });
    expect(run(min({ amount_cents: 10000 }), small()).checks.minimum_loss.status).toBe("not_met");
    expect(
      run(min({ amount_cents: 10000, waived_for: ["sexual_assault"] }), small(), { forensic_exam: true }).checks
        .minimum_loss.status,
    ).toBe("waived");
    expect(run(min({ amount_cents: 10000, waived_for: ["sexual_assault"] }), small()).checks.minimum_loss.status).toBe(
      "not_met",
    );
    expect(run(min({ days_lost: 5 }), small()).checks.minimum_loss.status).toBe("unknown");
    expect(run([MEDICAL], small()).checks.minimum_loss).toEqual({ status: "met", rule_ids: [] });
  });

  it("10. uses the longest deadline, lists all, and reports late filings", () => {
    const rules = [
      MEDICAL,
      rule("FILE-1", "filing_deadline", { years: 1 }),
      rule("FILE-2", "filing_deadline", { days: 1000 }),
      rule("FILE-3", "filing_deadline", { extension: "good cause" }),
    ];
    const ok = run(rules, [item({})]);
    expect(ok.checks.deadline).toEqual({
      status: "ok",
      deadline_date: "2029-03-10",
      rule_ids: ["FILE-1", "FILE-2", "FILE-3"],
    });
    const late = run(rules, [item({})], { as_of_date: "2029-03-11" });
    expect(late.checks.deadline.status).toBe("late");
    expect(run([MEDICAL], [item({})]).checks.deadline).toEqual({
      status: "unknown",
      deadline_date: null,
      rule_ids: [],
    });
  });

  it("11. reporting: police report, exam alternative, required, unknown, no rule", () => {
    const rules = [
      MEDICAL,
      rule("REP-1", "reporting_requirement", { required: true, alternatives: ["forensic_exam"] }),
      rule("REP-2", "reporting_requirement", { required: true }),
    ];
    const one = () => [item({})];
    expect(run(rules, one(), { police_report: "yes" }).checks.reporting).toEqual({
      status: "satisfied",
      rule_ids: ["REP-1", "REP-2"],
    });
    expect(run(rules, one(), { police_report: "no", forensic_exam: true }).checks.reporting).toEqual({
      status: "satisfied",
      rule_ids: ["REP-1", "REP-2"],
    });
    expect(run(rules, one(), { police_report: "no" }).checks.reporting.status).toBe("required");
    expect(run(rules, one(), { police_report: "unknown" }).checks.reporting.status).toBe("unknown");
    // An advocate or protective order might still apply, so "no" alone cannot make it required.
    const advocate = [MEDICAL, rule("REP-3", "reporting_requirement", { required: true, alternatives: ["advocate"] })];
    expect(run(advocate, one(), { police_report: "no" }).checks.reporting.status).toBe("unknown");
    const optional = [MEDICAL, rule("REP-4", "reporting_requirement", { required: false })];
    expect(run(optional, one(), { police_report: "no" }).checks.reporting.status).toBe("unknown");
    expect(run([MEDICAL], one()).checks.reporting).toEqual({ status: "satisfied", rule_ids: [] });
  });

  it("12. lists info rules in file order and never uses them to screen", () => {
    const out = run(
      [rule("CON-1", "conduct_reduction"), MEDICAL, rule("RES-1", "residency"), rule("ELIG-1", "eligible_crime")],
      [item({})],
    );
    expect(out.info_rule_ids).toEqual(["CON-1", "RES-1", "ELIG-1"]);
    expect(out.totals.allowed_cents).toBe(10000);
  });

  it("orders lines by (date, item_id) and keeps integer cents everywhere", () => {
    const late = item({ item_id: "a", date: "2026-07-01" });
    const early2 = item({ item_id: "b", date: "2026-06-20" });
    const early1 = item({ item_id: "a2", date: "2026-06-20" });
    const out = run([MEDICAL], [late, early2, early1]);
    expect(out.lines.map((l) => `${l.item_id}`)).toEqual(["a2", "b", "a"]);
    for (const l of out.lines) {
      expect(Number.isSafeInteger(l.allowed_cents) && Number.isSafeInteger(l.requested_cents)).toBe(true);
    }
    expect(out.trace.length).toBeGreaterThanOrEqual(out.lines.length);
  });

  it("rejects fractional cents", () => {
    expect(() => run([MEDICAL], [item({ amount_cents: 10.5 })])).toThrow(/whole cents/);
    expect(() => run([MEDICAL], [item({ amount_cents: -100 })])).toThrow(/whole cents/);
    expect(() => run([MEDICAL], [item({ insurance_paid_cents: 0.1 })])).toThrow(/whole cents/);
  });
});

describe("readings shared with the reference engine", () => {
  it("minimum loss reads a string waived_for, and a rule with no threshold leaves nothing to fail", () => {
    const small = () => [item({ amount_cents: 5000 })];
    const str = [
      MEDICAL,
      rule("MIN-S", "minimum_loss", {
        amount_cents: 10000,
        waived_for: "sexual_assault victims" as unknown as string[],
      }),
    ];
    expect(run(str, small(), { forensic_exam: true }).checks.minimum_loss.status).toBe("waived");
    // MI-style prose never matches the exact entry, so the check stays not_met (refengine reading 11).
    const prose = [
      MEDICAL,
      rule("MIN-P", "minimum_loss", { amount_cents: 10000, waived_for: ["criminal sexual conduct"] }),
    ];
    expect(run(prose, small(), { forensic_exam: true }).checks.minimum_loss.status).toBe("not_met");
    expect(run([MEDICAL, rule("MIN-0", "minimum_loss", {})], small()).checks.minimum_loss).toEqual({
      status: "met",
      rule_ids: ["MIN-0"],
    });
    // Any unwaived shortfall wins over a waived one.
    const two = [
      MEDICAL,
      rule("MIN-A", "minimum_loss", { amount_cents: 10000, waived_for: ["sexual_assault"] }),
      rule("MIN-B", "minimum_loss", { amount_cents: 8000 }),
    ];
    expect(run(two, small(), { forensic_exam: true }).checks.minimum_loss.status).toBe("not_met");
  });

  it("deadline: years win over days on one rule", () => {
    const rules = [MEDICAL, rule("FILE-1", "filing_deadline", { years: 1, days: 2000 })];
    expect(run(rules, [item({})]).checks.deadline.deadline_date).toBe("2027-06-14");
  });

  it("a cap per something the engine cannot measure flags every line and cuts nothing", () => {
    const move = item({ expense: "relocation", amount_cents: 500000, units: 3 });
    const out = run(
      [
        rule("COV-R", "covered_expense", { expense: "relocation" }),
        rule("CAP-R", "expense_cap", { expense: "relocation", amount_cents: 100000, per: "residence" }),
      ],
      [move],
    );
    expect(lineOf(out, move.item_id)).toMatchObject({
      allowed_cents: 500000,
      cap_rule_id: null,
      flags: ["rate_unverified:CAP-R"],
    });
    expect(out.trace.map((t) => t.op)).toContain("rate_unverified");
  });

  it("a cap walk logs every line after the crossing, even one already at zero", () => {
    const a = item({ amount_cents: 60000, date: "2026-07-01" });
    const b = item({ amount_cents: 60000, date: "2026-07-02" });
    const c = item({ amount_cents: 10000, insurance_paid_cents: 10000, date: "2026-07-03" });
    const out = run(
      [MEDICAL, rule("COLL", "collateral_source"), rule("TOT", "total_cap", { amount_cents: 100000 })],
      [a, b, c],
    );
    const capOps = out.trace.filter((t) => t.op === "total_cap");
    expect(capOps.map((t) => [t.item_id, t.delta_cents])).toEqual([
      [b.item_id, -20000],
      [c.item_id, 0],
    ]);
    expect(lineOf(out, c.item_id).cap_rule_id).toBe("TOT");
  });

  it("sorts ids by code point, rejects duplicate ids and fractional units, and maps odd expenses to unknown", () => {
    const hi = item({ item_id: "\u{1F600}", date: "2026-06-20" });
    const lo = item({ item_id: "\uFF5E", date: "2026-06-20" });
    expect(run([MEDICAL], [hi, lo]).lines.map((l) => l.item_id)).toEqual(["\uFF5E", "\u{1F600}"]);
    expect(() => run([MEDICAL], [item({ item_id: "x" }), item({ item_id: "x" })])).toThrow(/duplicate/);
    expect(() => run([MEDICAL], [item({ units: 1.5 })])).toThrow(/units/);
    const odd = item({ expense: "groceries" as never });
    expect(lineOf(run([MEDICAL], [odd]), odd.item_id)).toMatchObject({ expense: "unknown", status: "unknown_rule" });
  });
});

describe("Rowan, Michigan (fixtures)", () => {
  const web = path.resolve(import.meta.dirname, "..");
  const read = (p: string) => JSON.parse(readFileSync(path.join(web, p), "utf8"));
  const mi = read("public/data/law/MI.json") as Jurisdiction;
  const fixtureIn = read("fixtures/rowan-mi.input.json") as EngineInput;
  const fixtureOut = read("fixtures/rowan-mi.output.json");

  it("reproduces the committed output fixture", () => {
    const out = evaluatePreview(fixtureIn, mi, fixtureOut.law_image_sha256);
    expect(out).toEqual(fixtureOut);
  });

  it("holds the exam bill and counts only the confirmed bill lines", () => {
    expect(fixtureOut.totals).toEqual({
      requested_cents: 139400,
      allowed_cents: 139400,
      held_cents: 32500,
      by_expense: { medical: 139400 },
    });
    const statuses = fixtureOut.lines.map((l: { status: string }) => l.status);
    expect(statuses.filter((s: string) => s === "needs_confirmation")).toHaveLength(8);
    expect(fixtureOut.checks.deadline.deadline_date).toBe("2031-06-14");
    expect(fixtureOut.checks.reporting.status).toBe("satisfied");
  });

  it("cites only rules that exist in the verified corpus", () => {
    const ids = new Set(mi.rules.map((r) => r.id));
    for (const l of fixtureOut.lines) for (const id of l.rule_ids) expect(ids.has(id)).toBe(true);
  });

  it("recomputes to $3,214.25 once every guess is confirmed", () => {
    const all = { ...fixtureIn, items: fixtureIn.items.map((i) => ({ ...i, confirmed: true })) };
    const out = evaluatePreview(all, mi, "sha");
    expect(out.totals.allowed_cents).toBe(321425);
    expect(out.totals.held_cents).toBe(32500);
  });
});

describe("every verified state", () => {
  const web = path.resolve(import.meta.dirname, "..");
  const input = JSON.parse(readFileSync(path.join(web, "fixtures/rowan-mi.input.json"), "utf8")) as EngineInput;
  const all = { ...input, items: input.items.map((i) => ({ ...i, confirmed: true })) };
  const states = JSON.parse(readFileSync(path.join(web, "public/data/jurisdictions.json"), "utf8")) as {
    st: string;
    rules: number;
  }[];

  it.each(states.filter((s) => s.rules > 0).map((s) => s.st))("runs Rowan's costs under %s law", (st) => {
    const law = JSON.parse(readFileSync(path.join(web, "public/data/law", `${st}.json`), "utf8")) as Jurisdiction;
    const out = evaluatePreview({ ...all, jurisdiction: st }, law, "sha");
    const ids = new Set(law.rules.map((r) => r.id));
    expect(out.lines).toHaveLength(all.items.length);
    for (const l of out.lines) {
      expect(Number.isSafeInteger(l.allowed_cents)).toBe(true);
      expect(l.allowed_cents).toBeLessThanOrEqual(l.requested_cents);
      for (const id of [...l.rule_ids, ...(l.cap_rule_id ? [l.cap_rule_id] : [])]) expect(ids.has(id)).toBe(true);
    }
    const hasExamRule = law.rules.some((r) => r.category === "exam_no_bill" || r.category === "exam_payment");
    expect(out.totals.held_cents).toBe(hasExamRule ? 32500 : 0);
  });
});
