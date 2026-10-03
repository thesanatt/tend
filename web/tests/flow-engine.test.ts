// The flow's sample files, and the flow's engine input run through the real WebAssembly engine.
// The engine part needs compiled law images (public/engine/laws/*.tlaw from `make -C ../engine wasm`)
// and is skipped, and says so, when they are not built.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildEngineInput } from "@/components/flow/claim";
import { rawFinder } from "@/components/flow/FlowProvider";
import { demoBankTxns, sampleBillFile, sampleStatementFile } from "@/components/flow/samples";
import { SAMPLE_BILL_SHA256 } from "@/components/flow/samples/rowan";
import { initialState, reducer, type FlowItem } from "@/components/flow/state";
import { toEngineInput } from "@/lib/engine";
import { mockBillReader, mockClassifier, mockStatementParser } from "@/lib/mocks";
import type { EngineInput, EngineOutput } from "@/lib/types";

const web = path.resolve(import.meta.dirname, "..");
const image = path.join(web, "public/engine/laws/MI.tlaw");
const haveEngine = existsSync(image) && existsSync(path.join(web, "public/engine/tend_engine.mjs"));

describe("sample files", () => {
  it("the sample statement is a plain bank export of Rowan's fictional account", async () => {
    const { txns, warnings } = await mockStatementParser.parse(sampleStatementFile());
    expect(warnings).toEqual([]);
    expect(txns).toHaveLength(190);
    expect(txns.every((t) => Number.isSafeInteger(t.amount_cents))).toBe(true);
    // Money out is positive in the contract; paychecks come in as negative.
    expect(txns.find((t) => /payroll/.test(t.description))!.amount_cents).toBeLessThan(0);
  });

  it("the sample bill is the seed's fictional PDF, byte for byte", async () => {
    const file = sampleBillFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(SAMPLE_BILL_SHA256);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const reading = await mockBillReader().read(file);
    expect(reading).toMatchObject({ status: "ok", total_cents: 44300, sums_match: true });
    expect(reading.lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(44300);
  });

  it("the demo bank holds the same history plus the pending hospital bill", () => {
    const { txns, billIds } = demoBankTxns();
    expect(txns).toHaveLength(191);
    expect(txns.filter((t) => billIds.includes(t.id)).map((t) => t.amount_cents)).toEqual([44300]);
    expect(txns.every((t) => t.origin === "nessie")).toBe(true);
    const find = rawFinder(txns);
    expect(find(`nessie:${txns[3].id}`)).toBe(txns[3]);
    expect(find(`nessie:${txns[3].id}:pay`)).toBe(txns[3]);
  });
});

async function flowInput(): Promise<EngineInput> {
  const { txns } = await mockStatementParser.parse(sampleStatementFile());
  const classified = await mockClassifier.classify(txns, { st: "MI", incident_date: "2026-06-14" });
  const items: FlowItem[] = classified.map((c) => ({ ...c, item_id: `stmt:x:${c.item_id}`, origin: "statement" }));
  let s = reducer(initialState(), {
    type: "check",
    patch: { st: "MI", date: "2026-06-14", exam: "yes", police: "not_yet" },
  });
  s = reducer(s, {
    type: "addSource",
    source: { id: "s", kind: "statement", label: "s.csv", read: txns.length, found: items.length, warnings: [], sample: true },
    items,
  });
  const bill = await mockBillReader().read(sampleBillFile());
  s = reducer(s, {
    type: "addBill",
    bill: { id: "bill-x", label: "b.pdf", reading: bill, replaces: null, choice: null, sample: true },
    items: bill.lines.map((l, i) => ({
      item_id: `bill:x:${l.line_id}`,
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
      bill_id: "bill-x",
      line_no: i + 1,
    })),
  });
  return toEngineInput(buildEngineInput(s, "2026-10-03")!);
}

describe.skipIf(!haveEngine)("the flow on the real law engine (WebAssembly, Michigan)", () => {
  async function evaluate(input: EngineInput): Promise<EngineOutput> {
    const { loadTend } = (await import(pathToFileURL(path.join(web, "public/engine/tend_engine.mjs")).href)) as {
      loadTend: () => Promise<{ evaluate: (img: Uint8Array, claim: unknown) => EngineOutput & { error?: unknown } }>;
    };
    const tend = await loadTend();
    const out = tend.evaluate(new Uint8Array(readFileSync(image)), input);
    expect(out.error).toBeUndefined();
    return out;
  }

  it("holds the exam line, caps counseling at the session rate, and dates the deadline", async () => {
    const input = await flowInput();
    const out = await evaluate(input);
    expect(out.lines).toHaveLength(input.items.length);
    const exam = out.lines.find((l) => l.item_id === "bill:x:2")!;
    expect(exam.status).toBe("held");
    expect(exam.rule_ids).toContain("MI-EXAM-1");
    const sessions = out.lines.filter((l) => l.expense === "counseling" && l.status === "eligible");
    expect(sessions.length).toBe(16);
    expect(sessions.every((l) => l.allowed_cents === 12500)).toBe(true);
    expect(out.lines.find((l) => l.status === "excluded")?.rule_ids).toEqual(["MI-EXCL-1"]);
    expect(out.checks.deadline).toMatchObject({ status: "ok", deadline_date: "2031-06-14" });
    expect(out.checks.reporting.status).toBe("satisfied");
    expect(out.totals.held_cents).toBe(32500);
    const sum = out.lines.filter((l) => l.status === "eligible").reduce((s, l) => s + l.allowed_cents, 0);
    expect(out.totals.allowed_cents).toBe(sum);
  });
});
