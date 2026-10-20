// @vitest-environment jsdom
// The survivor flow says no more than the rule behind it (lib/hedge.ts): where an exam rule carries a
// scope or condition Tend does not ask about, the flow says "may", shows the condition, and asks the
// survivor to check the rule before she pays. It must agree with the state page, which reads the same
// params (components/public/summary.ts). Michigan's demo totals are checked on the real engine in
// flow-engine.test.ts.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BillsScreen from "@/components/flow/bills/BillsScreen";
import CheckScreen from "@/components/flow/check/CheckScreen";
import { buildCheckSummary, setAsideIds } from "@/components/flow/checkSummary";
import type { Action, BillRecord, FlowItem } from "@/components/flow/state";
import { EMPTY_CHECK } from "@/components/flow/state";
import { buildStateSummary } from "@/components/public/summary";
import type { IrSummary } from "@/components/public/types";
import { examCountsIf, examHold, sourceIsLaw } from "@/lib/hedge";
import { SAMPLE_BILL_READING } from "@/lib/mocks";
import type { EngineInput, EngineOutput, Jurisdiction } from "@/lib/types";
import { michiganOutput, renderFlow, stateFrom, stubLawFetch, testServices } from "./helpers/flow";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/check",
}));

beforeEach(() => {
  stubLawFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const web = path.resolve(import.meta.dirname, "..");
const read = <T,>(p: string) => JSON.parse(readFileSync(path.join(web, p), "utf8")) as T;
const law = (st: string) => read<Jurisdiction>(`public/data/law/${st}.json`);
const ir = (st: string) => read<IrSummary>(`public/data/ir/${st}.json`);
const STATES = readdirSync(path.join(web, "public/data/law"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5))
  .sort();

// Alaska's no-bill statute holds "if you are 16 or older" (AS 18.68.040), which Check never asks.
const AK_TERMS = "You should not have to pay for a sexual assault forensic exam if you are 16 or older.";

describe("the flow and the state page read the exam rules the same way", () => {
  it.each(STATES)("%s", (st) => {
    const l = law(st);
    const page = buildStateSummary(l, ir(st));
    const exam = page.sections.find((s) => s.id === "exam")!.facts.find((f) => f.key === "exam-no-bill");
    const tile = page.keyFacts.find((k) => k.id === "exam");
    const hold = examHold(l, setAsideIds(ir(st)));
    // A plain hold only where the page says "$0" for the exam.
    if (hold.plain) expect(tile?.big).toBe("$0");
    // The page's "$0" is a plain hold unless the first rule is a program page (none today).
    if (tile?.big === "$0") expect(hold.plain || !sourceIsLaw(l, hold.noBill[0])).toBe(true);
    // The condition the flow shows is the page's own exam line, word for word.
    if (hold.terms) expect(hold.terms).toBe(exam?.text);
    // Every rule the hold cites is one the survivor's claim can use.
    for (const id of hold.ruleIds) expect(l.rules.find((r) => r.id === id)?.params?.applies_to).toBeFalsy();
  });

  it("knows which states narrow the exam rule, and that Michigan does not", () => {
    const narrowed = STATES.filter((st) => {
      const h = examHold(law(st));
      return h.noBill.length > 0 && !h.plain;
    });
    // The design's list (AK, AR, AZ, CO, FL, MD, ME, MN, MS, ND, NM, OH, OR, SC, SD, TX, VA, WI) plus the
    // place conditions the merged rules added on payment rules (DE, GA, KS, MA, MO, VT).
    expect(narrowed).toEqual(
      [
        ...["AK", "AR", "AZ", "CO", "FL", "MD", "ME", "MN", "MS", "ND", "NM", "OH", "OR", "SC", "SD", "TX", "VA", "WI"],
        ...["DE", "GA", "KS", "MA", "MO", "VT"],
      ].sort(),
    );
    expect(examHold(law("MI")).plain).toBe(true);
    // No law loaded: never plain.
    expect(examHold(null).plain).toBe(false);
  });

  it("the total says 'in most cases' exactly where the state page hedges it", () => {
    for (const st of STATES) {
      const l = law(st);
      const s = buildCheckSummary(l, null, { ...EMPTY_CHECK, st }, false, setAsideIds(ir(st)));
      const line = buildStateSummary(l, ir(st))
        .sections.find((x) => x.id === "costs")!
        .facts.find((f) => f.key === "total");
      if (!s.totalCap || !line) continue;
      expect(s.totalCap.hedged, st).toBe(line.text.startsWith("The most the program can pay in total is"));
    }
  });

  it("says the exam may count for the report where a limit, a discretion or a charge applies", () => {
    const limited = STATES.filter((st) => examCountsIf(law(st)).length);
    expect(limited).toEqual(["CT", "KS", "OK", "PA", "RI", "WV"]);
  });

  it("lists other records only from the program's own reporting rules", () => {
    // WY-REP-2 is about mental health counseling only (scope), so its protective order is not listed.
    const wy = buildCheckSummary(law("WY"), null, { ...EMPTY_CHECK, st: "WY" }, false);
    expect(wy.reporting.alternatives).toEqual([]);
    expect(wy.reporting.altRuleIds).toEqual([]);
    const mi = buildCheckSummary(law("MI"), null, { ...EMPTY_CHECK, st: "MI" }, false);
    expect(mi.reporting.alternatives).toEqual(["forensic_exam"]);
  });
});

describe("Check", () => {
  const check = (st: string): Action => ({
    type: "check",
    patch: { st, date: "2026-06-14", exam: "yes", police: "not_yet" },
  });

  it("Alaska: says the exam may be free and shows the rule's condition", async () => {
    renderFlow(<CheckScreen />, { initial: stateFrom([check("AK")]) });
    expect(
      await screen.findByText("You may not have to pay for the forensic exam. The rule below says when."),
    ).toBeTruthy();
    expect(screen.getByText(AK_TERMS)).toBeTruthy();
    expect(
      screen.getByText(
        "If one comes, add it in the next step. Tend holds that line while you check the rule, and gives you a letter that quotes it.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("You should not get a bill for the forensic exam.")).toBeNull();
    // The citation leads with the rule that carries the condition.
    expect(screen.getByRole("button", { name: /show the law for Bills for the forensic exam/ }).textContent).toMatch(
      /^AS 18\.68\.040/,
    );
  });

  it("Alaska in Spanish: the same hedge, with the condition in English and a note saying so", async () => {
    renderFlow(<CheckScreen />, { initial: stateFrom([check("AK")], "es"), lang: "es" });
    expect(
      await screen.findByText("Puede que no tengas que pagar el examen forense. La regla de abajo dice cuándo."),
    ).toBeTruthy();
    const terms = screen.getByText((_, el) => el?.tagName === "P" && el.textContent!.startsWith(AK_TERMS));
    expect(terms.getAttribute("lang")).toBe("en");
    expect(terms.textContent).toContain("Resumen en inglés");
  });

  it("Michigan: keeps the plain line, because its rule covers every survivor", async () => {
    renderFlow(<CheckScreen />, { initial: stateFrom([check("MI")]) });
    expect(await screen.findByText("You should not get a bill for the forensic exam.")).toBeTruthy();
    expect(
      screen.getByText("If one comes, add it in the next step. Tend holds that line and gives you a letter."),
    ).toBeTruthy();
    expect(screen.queryByText(/The rule below says when/)).toBeNull();
    expect(screen.getByText("In total, up to $45,000")).toBeTruthy();
  });

  it("Connecticut: the exam may count for the report, within the rule's 120 hours", async () => {
    renderFlow(<CheckScreen />, {
      initial: stateFrom([check("CT")]),
      services: testServices({
        evaluate: vi.fn(async (input: EngineInput) => {
          const out = michiganOutput(input);
          return {
            output: {
              ...out,
              checks: { ...out.checks, reporting: { status: "satisfied" as const, rule_ids: ["CT-REPORT-1"] } },
            },
            backend: "wasm" as const,
            detail: "test",
          };
        }),
      }),
    });
    expect(
      await screen.findByText(
        "Your forensic exam may count in place of a police report here. The rule below says when.",
      ),
    ).toBeTruthy();
  });

  it("California: no rule requires a report, but a survivor still needs one of the records the rules name", async () => {
    renderFlow(<CheckScreen />, {
      initial: stateFrom([{ type: "check", patch: { st: "CA", date: "2026-06-14", exam: "no", police: "no" } }]),
      services: testServices({
        evaluate: vi.fn(async (input: EngineInput) => {
          const out = michiganOutput(input);
          return {
            output: {
              ...out,
              checks: { ...out.checks, reporting: { status: "not_required" as const, rule_ids: ["CA-REPORT-1"] } },
            },
            backend: "wasm" as const,
            detail: "test",
          };
        }),
      }),
    });
    expect(
      await screen.findByText(
        "A police report is not the only record that counts here. The rule below says which others count, and when.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/^These can count instead: /)).toBeTruthy();
    expect(screen.queryByText("You don't need a police report.")).toBeNull();
  });

  it("South Carolina: the total says 'in most cases' and cites the rule with the higher amount", async () => {
    renderFlow(<CheckScreen />, { initial: stateFrom([check("SC")]) });
    expect(
      await screen.findByText("In total, up to $15,000 in most cases. The rule below has the details."),
    ).toBeTruthy();
  });
});

describe("bill triage", () => {
  const billLines: FlowItem[] = SAMPLE_BILL_READING.lines.map((l, i) => ({
    item_id: `bill:abc:${l.line_id}`,
    date: "2026-06-14",
    amount_cents: l.amount_cents,
    expense: l.expense,
    confirmed: true,
    insurance_paid_cents: 0,
    is_bill: true,
    units: 0,
    unit: null,
    tags: [],
    description: l.description,
    source: "rule",
    reason: "",
    confidence: 1,
    origin: "bill",
    merchant: "Riverbend General Hospital",
    bill_id: "bill-abc",
    line_no: i + 1,
  }));
  const bill: BillRecord = {
    id: "bill-abc",
    label: "riverbend.pdf",
    reading: SAMPLE_BILL_READING,
    replaces: null,
    choice: null,
    sample: true,
  };
  // The mock engine cites Michigan's exam rules; in Alaska the held line cites Alaska's.
  const alaska = testServices({
    evaluate: vi.fn(async (input: EngineInput) => {
      const out: EngineOutput = michiganOutput(input);
      const ak = (id: string) => ({ "MI-EXAM-1": "AK-EXAM-1", "MI-EXAM-2": "AK-EXAM-2" })[id] ?? id;
      return {
        output: { ...out, lines: out.lines.map((l) => ({ ...l, rule_ids: l.rule_ids.map(ak) })) },
        backend: "wasm" as const,
        detail: "test",
      };
    }),
  });
  const withBill = (st: string): Action[] => [
    { type: "check", patch: { st, date: "2026-06-14", exam: "yes", police: "not_yet" } },
    { type: "addBill", bill, items: billLines },
  ];

  it("Alaska: asks her to check the rule before she pays, shows its condition, and says the program decides", async () => {
    renderFlow(<BillsScreen />, { initial: stateFrom(withBill("AK")), services: alaska });
    expect(await screen.findByRole("heading", { name: "Check the rule before you pay this line" })).toBeTruthy();
    expect(
      screen.getByText(
        "Medical forensic exam, deductible applied, $325.00. Alaska's rules protect some survivors from this charge. Read the rule to see if it covers you.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(AK_TERMS)).toBeTruthy();
    expect(
      screen.getByText("If you are not sure it covers you, ask the program before you pay. The program decides."),
    ).toBeTruthy();
    expect(screen.getByText("The law may protect you from this charge.")).toBeTruthy();
    expect(screen.getByText("Held while you check the rule")).toBeTruthy();
    // The quote is the rule that carries the condition.
    const ak1 = law("AK").rules.find((r) => r.id === "AK-EXAM-1")!;
    expect(screen.getByText(ak1.quote)).toBeTruthy();
    expect(screen.queryByText(/Don't pay/)).toBeNull();
    expect(screen.queryByText(/law says you should not be billed/)).toBeNull();
  });

  it("Michigan: keeps the plain hold", async () => {
    renderFlow(<BillsScreen />, { initial: stateFrom(withBill("MI")) });
    expect(await screen.findByRole("heading", { name: "Don't pay this line" })).toBeTruthy();
    expect(screen.getByText("Held by law. Don't pay")).toBeTruthy();
    expect(screen.queryByText("Check the rule before you pay this line")).toBeNull();
    expect(screen.queryByText(/The program decides/)).toBeNull();
  });
});
