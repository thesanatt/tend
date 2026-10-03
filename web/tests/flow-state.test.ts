// The survivor flow's state and its joins to the law engine (components/flow/state.ts, claim.ts).
import { describe, expect, it } from "vitest";
import {
  beforeDate,
  billPlan,
  buildEngineInput,
  buildRows,
  countingDate,
  groupRows,
  notCovered,
  plants,
  policeForEngine,
  questions,
} from "@/components/flow/claim";
import {
  initialState,
  isFlowState,
  newCosts,
  recordOf,
  reducer,
  type BillRecord,
  type FlowItem,
  type FlowState,
} from "@/components/flow/state";
import { mockEngineOutput } from "@/lib/mocks/engine";
import type { BillReading } from "@/lib/contracts";

const TODAY = "2026-10-03";

function item(id: string, over: Partial<FlowItem> = {}): FlowItem {
  return {
    item_id: id,
    date: "2026-06-20",
    amount_cents: 1000,
    expense: "transportation",
    confirmed: false,
    insurance_paid_cents: 0,
    is_bill: false,
    units: 0,
    unit: null,
    tags: [],
    description: `item ${id}`,
    source: "rule",
    reason: "A ride",
    confidence: 0.7,
    origin: "statement",
    ...over,
  };
}

const reading = (total: number): BillReading => ({
  status: "ok",
  provider: "Riverbend General Hospital",
  total_cents: total,
  lines: [
    { line_id: "1", description: "Emergency visit", amount_cents: 7500, expense: "medical" },
    { line_id: "2", description: "Forensic exam", amount_cents: 32500, expense: "forensic_exam" },
    { line_id: "3", description: "Lab", amount_cents: 4300, expense: "medical" },
  ],
  sums_match: true,
  source: "rule",
});

function withCheck(state: FlowState = initialState()): FlowState {
  return reducer(state, {
    type: "check",
    patch: { st: "MI", date: "2026-06-14", exam: "yes", police: "not_yet" },
  });
}

function billItemsFor(id: string): FlowItem[] {
  return reading(44300).lines.map((l, i) =>
    item(`bill:${id}:${l.line_id}`, {
      origin: "bill",
      bill_id: id,
      line_no: i + 1,
      is_bill: true,
      confirmed: true,
      expense: l.expense,
      amount_cents: l.amount_cents,
      description: l.description,
    }),
  );
}

describe("check answers", () => {
  it("clears the date when the survivor is not sure, and the reverse", () => {
    let s = withCheck();
    s = reducer(s, { type: "check", patch: { dateUnsure: true } });
    expect(s.check).toMatchObject({ date: "", dateUnsure: true });
    s = reducer(s, { type: "check", patch: { date: "2026-07-01" } });
    expect(s.check).toMatchObject({ date: "2026-07-01", dateUnsure: false });
  });

  it("maps police answers to the engine without guessing", () => {
    expect(policeForEngine("yes")).toBe("yes");
    expect(policeForEngine("no")).toBe("no");
    expect(policeForEngine("not_yet")).toBe("no");
    expect(policeForEngine("unsure")).toBe("unknown");
    expect(policeForEngine(null)).toBe("unknown");
  });
});

describe("engine input", () => {
  it("is null until a state is chosen", () => {
    expect(buildEngineInput(initialState(), TODAY)).toBeNull();
  });

  it("sends direct matches confirmed, answers as given, and drops what the survivor said no to", () => {
    let s = withCheck();
    s = reducer(s, {
      type: "addSource",
      source: { id: "s", kind: "statement", label: "s.csv", read: 4, found: 4, warnings: [], sample: true },
      items: [
        item("a", { confirmed: true, expense: "counseling", unit: "session", units: 1 }),
        item("b"),
        item("c"),
        item("d", { expense: "property_replacement", tags: ["phone"] }),
      ],
    });
    s = reducer(s, { type: "answer", ids: ["b"], value: "yes" });
    s = reducer(s, { type: "answer", ids: ["c"], value: "no" });
    s = reducer(s, { type: "answer", ids: ["d"], value: "unsure" });
    const input = buildEngineInput(s, TODAY)!;
    const byId = Object.fromEntries(input.items.map((i) => [i.item_id, i]));
    expect(Object.keys(byId).sort()).toEqual(["a", "b", "d"]);
    expect(byId.a.confirmed).toBe(true);
    expect(byId.b.confirmed).toBe(true);
    expect(byId.d.confirmed).toBe(false);
    expect(byId.a).toMatchObject({ unit: "session", units: 1, tags: [] });
    expect(byId.d).toMatchObject({ tags: ["phone"] });
    expect(input.context).toEqual({
      incident_date: "2026-06-14",
      as_of_date: TODAY,
      police_report: "no",
      forensic_exam: true,
    });
  });

  it("unchecking a direct match leaves it out; checking it again brings it back", () => {
    let s = withCheck();
    s = reducer(s, {
      type: "addSource",
      source: { id: "s", kind: "statement", label: "s.csv", read: 1, found: 1, warnings: [], sample: false },
      items: [item("a", { confirmed: true })],
    });
    s = reducer(s, { type: "answer", ids: ["a"], value: "no" });
    expect(buildEngineInput(s, TODAY)!.items).toHaveLength(0);
    s = reducer(s, { type: "answer", ids: ["a"], value: null });
    expect(buildEngineInput(s, TODAY)!.items[0].confirmed).toBe(true);
  });

  it("without a date, counts from the earliest cost and never from a guess", () => {
    let s = reducer(withCheck(), { type: "check", patch: { dateUnsure: true } });
    expect(countingDate(s, TODAY)).toBe(TODAY);
    s = reducer(s, {
      type: "addSource",
      source: { id: "s", kind: "statement", label: "s.csv", read: 2, found: 2, warnings: [], sample: false },
      items: [item("late", { date: "2026-08-01" }), item("early", { date: "2026-06-20" })],
    });
    expect(buildEngineInput(s, TODAY)!.context.incident_date).toBe("2026-06-20");
  });

  it("treats a future or half-typed date as unknown, and never sends a line that is not money", () => {
    let s = reducer(withCheck(), { type: "check", patch: { date: "2027-01-01" } });
    s = reducer(s, {
      type: "addSource",
      source: { id: "s", kind: "statement", label: "s.csv", read: 3, found: 3, warnings: [], sample: false },
      items: [item("ok"), item("refund", { amount_cents: -500 }), item("frac", { amount_cents: 12.5 })],
    });
    const input = buildEngineInput(s, TODAY)!;
    expect(input.context.incident_date).toBe("2026-06-20");
    expect(input.items.map((i) => i.item_id)).toEqual(["ok"]);
    s = reducer(s, { type: "check", patch: { date: "2026-02-30" } });
    expect(countingDate(s, TODAY)).toBe("2026-06-20");
  });

  it("keeps the first reading of a cost when a source is read twice", () => {
    const source = {
      id: "s",
      kind: "statement" as const,
      label: "s.csv",
      read: 1,
      found: 1,
      warnings: [],
      sample: false,
    };
    let s = reducer(withCheck(), { type: "addSource", source, items: [item("a", { amount_cents: 100 })] });
    s = reducer(s, { type: "addSource", source, items: [item("a", { amount_cents: 999 })] });
    expect(s.items).toHaveLength(1);
    expect(s.items[0].amount_cents).toBe(100);
    expect(s.sources).toHaveLength(1);
  });
});

describe("the same account read twice", () => {
  const ride = (id: string, over: Partial<FlowItem> = {}) =>
    item(id, { date: "2026-06-17", amount_cents: 1200, ...over });

  it("names the record each cost came from", () => {
    expect(recordOf(ride("stmt:abc:csv:7"))).toBe("stmt:abc");
    expect(recordOf(ride("nessie:rowan-7", { origin: "bank" }))).toBe("nessie");
    expect(recordOf(ride("bill:def:2", { origin: "bill" }))).toBe("bill:def");
  });

  it("a statement and the bank showing the same ride count it once", () => {
    const gathered = [ride("stmt:abc:csv:7")];
    const fromBank = [ride("nessie:rowan-7", { origin: "bank", merchant: "Wayfare Rides" })];
    expect(newCosts(gathered, fromBank)).toEqual({ fresh: [], already: 1 });
  });

  it("two real rides on one day still count twice, each matched once", () => {
    const gathered = [ride("stmt:abc:csv:7"), ride("stmt:abc:csv:8")];
    const fromBank = [
      ride("nessie:r-7", { origin: "bank" }),
      ride("nessie:r-8", { origin: "bank" }),
      ride("nessie:r-9", { origin: "bank" }),
    ];
    const { fresh, already } = newCosts(gathered, fromBank);
    expect(already).toBe(2);
    expect(fresh.map((i) => i.item_id)).toEqual(["nessie:r-9"]);
  });

  it("keeps costs that differ in day, amount, kind, or merchant", () => {
    const gathered = [ride("stmt:abc:csv:7", { merchant: "Wayfare Rides" })];
    const other = [
      ride("nessie:a", { origin: "bank", date: "2026-06-18" }),
      ride("nessie:b", { origin: "bank", amount_cents: 1300 }),
      ride("nessie:c", { origin: "bank", expense: "prescription" }),
      ride("nessie:d", { origin: "bank", merchant: "Larkfield Cab Co" }),
    ];
    expect(newCosts(gathered, other)).toEqual({ fresh: other, already: 0 });
  });

  it("never folds costs inside one record, or bill lines, into each other", () => {
    const gathered = [ride("stmt:abc:csv:7")];
    expect(newCosts(gathered, [ride("stmt:abc:csv:9")]).already).toBe(0);
    const line = ride("bill:def:1", { origin: "bill", is_bill: true });
    expect(newCosts(gathered, [line]).fresh).toEqual([line]);
  });
});

describe("bills", () => {
  const bankBill = item("bank:nessie:bill-1", {
    origin: "bank",
    is_bill: true,
    amount_cents: 44300,
    expense: "medical",
  });

  it("an itemized bill replaces the bank bill it explains, so nothing counts twice", () => {
    let s = reducer(withCheck(), {
      type: "addSource",
      source: { id: "bank", kind: "bank", label: "Checking", read: 1, found: 1, warnings: [], sample: true },
      items: [bankBill],
    });
    const bill: BillRecord = {
      id: "bill-x",
      label: "b.pdf",
      reading: reading(44300),
      replaces: null,
      choice: null,
      sample: true,
    };
    s = reducer(s, { type: "addBill", bill, items: billItemsFor("bill-x") });
    expect(s.bills[0].replaces).toBe(bankBill.item_id);
    const ids = buildEngineInput(s, TODAY)!.items.map((i) => i.item_id);
    expect(ids).not.toContain(bankBill.item_id);
    expect(ids).toHaveLength(3);
    expect(buildRows(s, null).find((r) => r.item.item_id === bankBill.item_id)?.status).toBe("replaced");
  });

  it("does not replace a bank bill with a different total", () => {
    let s = reducer(withCheck(), {
      type: "addSource",
      source: { id: "bank", kind: "bank", label: "Checking", read: 1, found: 1, warnings: [], sample: true },
      items: [{ ...bankBill, amount_cents: 50000 }],
    });
    const bill: BillRecord = {
      id: "bill-x",
      label: "b.pdf",
      reading: reading(44300),
      replaces: null,
      choice: null,
      sample: true,
    };
    s = reducer(s, { type: "addBill", bill, items: billItemsFor("bill-x") });
    expect(s.bills[0].replaces).toBeNull();
  });

  it("holds the exam line, and nothing is payable until the engine decided every line", () => {
    let s = withCheck();
    const bill: BillRecord = {
      id: "bill-x",
      label: "b.pdf",
      reading: reading(44300),
      replaces: null,
      choice: null,
      sample: true,
    };
    s = reducer(s, { type: "addBill", bill, items: billItemsFor("bill-x") });
    expect(billPlan(s, s.bills[0], null)).toMatchObject({ decided: false, restCents: 0, heldCents: 0 });
    const output = mockEngineOutput(buildEngineInput(s, TODAY)!);
    const plan = billPlan(s, s.bills[0], output);
    expect(plan.decided).toBe(true);
    expect(plan.heldCents).toBe(32500);
    expect(plan.restCents).toBe(11800);
    expect(plan.repayable.map((i) => i.amount_cents)).toEqual([7500, 4300]);
    expect(plan.heldRuleIds).toEqual(["ZZ-EXAM-1", "ZZ-EXAM-2"]);
  });

  it("adding the same bill twice changes nothing", () => {
    const bill: BillRecord = {
      id: "bill-x",
      label: "b.pdf",
      reading: reading(44300),
      replaces: null,
      choice: null,
      sample: true,
    };
    let s = reducer(withCheck(), { type: "addBill", bill, items: billItemsFor("bill-x") });
    const again = reducer(s, { type: "addBill", bill, items: billItemsFor("bill-x") });
    expect(again).toBe(s);
    s = reducer(s, { type: "billChoice", billId: "bill-x", choice: "claim" });
    expect(s.bills[0].choice).toBe("claim");
  });
});

describe("groups and questions", () => {
  function gathered(): FlowState {
    return reducer(withCheck(), {
      type: "addSource",
      source: { id: "s", kind: "statement", label: "s.csv", read: 6, found: 6, warnings: [], sample: false },
      items: [
        item("r1"),
        item("r2"),
        item("r3"),
        item("c1", { expense: "counseling", confirmed: true, amount_cents: 15000, unit: "session", units: 1 }),
        item("p1", { expense: "property_replacement", tags: ["phone"], confirmed: true }),
        item("old", { date: "2026-05-01", confirmed: true, expense: "medical" }),
      ],
    });
  }

  it("puts costs in the five groups from the UX and offers Yes to all for repeated guesses", () => {
    const s = gathered();
    const output = mockEngineOutput(buildEngineInput(s, TODAY)!);
    const rows = buildRows(s, output);
    const groups = groupRows(rows);
    expect(groups.map((g) => g.group)).toEqual(["counseling", "travel"]);
    const travel = groups.find((g) => g.group === "travel")!;
    expect(travel.batch).toEqual({ expense: "transportation", ids: ["r1", "r2", "r3"] });
    expect(groups.find((g) => g.group === "counseling")!.allowedCents).toBe(12500);
    expect(questions(rows)).toHaveLength(3);
    expect(notCovered(rows).map((r) => r.item.item_id)).toEqual(["p1"]);
    expect(beforeDate(rows).map((r) => r.item.item_id)).toEqual(["old"]);
  });

  it("Yes to all answers every listed guess, and the batch goes away", () => {
    let s = gathered();
    s = reducer(s, { type: "answer", ids: ["r1", "r2", "r3"], value: "yes" });
    const output = mockEngineOutput(buildEngineInput(s, TODAY)!);
    const rows = buildRows(s, output);
    expect(questions(rows)).toHaveLength(0);
    expect(groupRows(rows).find((g) => g.group === "travel")!.batch).toBeNull();
    expect(output.totals.allowed_cents).toBe(12500 + 3000);
  });

  it("a single guess gets its own question, not a batch", () => {
    let s = gathered();
    s = reducer(s, { type: "answer", ids: ["r1", "r2"], value: "no" });
    const rows = buildRows(s, mockEngineOutput(buildEngineInput(s, TODAY)!));
    expect(groupRows(rows).find((g) => g.group === "travel")!.batch).toBeNull();
  });
});

describe("the garden", () => {
  it("grows one plant per line the program can pay; stage is real status", () => {
    let s = reducer(withCheck(), {
      type: "addSource",
      source: { id: "s", kind: "statement", label: "s.csv", read: 3, found: 3, warnings: [], sample: false },
      items: [
        item("a", { confirmed: true, expense: "counseling", amount_cents: 4000 }),
        item("b", { confirmed: true, expense: "counseling", amount_cents: 4000 }),
        item("q"),
      ],
    });
    const output = () => mockEngineOutput(buildEngineInput(s, TODAY)!);
    expect(plants(s, output()).map((p) => [p.item.item_id, p.stage])).toEqual([
      ["a", "sprout"],
      ["b", "sprout"],
    ]);
    s = reducer(s, { type: "life", ids: ["a"], patch: { doc: "receipt.pdf" } });
    expect(plants(s, output()).find((p) => p.item.item_id === "a")!.stage).toBe("leaf");
    s = reducer(s, { type: "filed", at: TODAY });
    expect(plants(s, output()).map((p) => p.stage)).toEqual(["bud", "bud"]);
    s = reducer(s, { type: "life", ids: ["b"], patch: { paid_at: TODAY } });
    expect(plants(s, output()).find((p) => p.item.item_id === "b")!.stage).toBe("bloom");
    s = reducer(s, { type: "life", ids: ["b"], patch: { paid_at: undefined } });
    expect(s.life.b).toBeUndefined();
    expect(plants(s, null)).toEqual([]);
  });
});

describe("saved state", () => {
  it("accepts only the shape this version writes", () => {
    const s = withCheck();
    expect(isFlowState(JSON.parse(JSON.stringify(s)))).toBe(true);
    expect(isFlowState({ ...s, v: 1 })).toBe(false);
    expect(isFlowState({ ...s, items: "no" })).toBe(false);
    expect(isFlowState(null)).toBe(false);
  });

  it("logs only what was sent, and reset forgets everything but the language", () => {
    let s = reducer(initialState("es"), { type: "sent", event: { kind: "share", at: "2026-10-03T12:00:00Z" } });
    s = reducer(s, { type: "share", record: { id: "x", url: "u", expires_at: "e", once: false, revoked: false } });
    s = reducer(s, { type: "revokeShare", id: "x" });
    expect(s.shares[0].revoked).toBe(true);
    expect(s.sent).toHaveLength(1);
    expect(reducer(s, { type: "reset", lang: s.lang })).toEqual(initialState("es"));
  });
});
