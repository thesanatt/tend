// Fixtures must keep the exact shapes in docs/SPEC.md so they can be swapped for live data.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import STATES from "@/lib/states.json";
import { EXPENSES, type BillAudit, type EngineInput, type EngineOutput, type JurisdictionSummary } from "@/lib/types";

const web = path.resolve(import.meta.dirname, "..");
const read = <T>(p: string) => JSON.parse(readFileSync(path.join(web, p), "utf8")) as T;
const isCents = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const STATUSES = ["out_of_window", "held", "excluded", "unknown_rule", "needs_confirmation", "eligible"];

describe("engine input fixture", () => {
  const input = read<EngineInput>("fixtures/rowan-mi.input.json");

  it("has exactly the SPEC keys", () => {
    expect(Object.keys(input).sort()).toEqual(["context", "items", "jurisdiction"]);
    expect(Object.keys(input.context).sort()).toEqual(["as_of_date", "forensic_exam", "incident_date", "police_report"]);
    for (const it of input.items) {
      expect(Object.keys(it).sort()).toEqual(
        ["amount_cents", "confirmed", "date", "description", "expense", "insurance_paid_cents", "is_bill", "item_id", "units"].sort(),
      );
      expect(isCents(it.amount_cents) && isCents(it.insurance_paid_cents)).toBe(true);
      expect([...EXPENSES, "unknown"]).toContain(it.expense);
    }
  });
});

describe("engine output fixtures", () => {
  for (const file of ["fixtures/rowan-mi.output.json", "fixtures/share-demo.json"]) {
    it(`${file} has the SPEC shape and consistent totals`, () => {
      const raw = read<EngineOutput & { output?: EngineOutput }>(file);
      const out = raw.output ?? raw;
      expect(Object.keys(out).sort()).toEqual(
        ["checks", "info_rule_ids", "jurisdiction", "law_image_sha256", "lines", "totals", "trace"].sort(),
      );
      for (const l of out.lines) {
        expect(STATUSES).toContain(l.status);
        expect(isCents(l.requested_cents) && isCents(l.allowed_cents)).toBe(true);
        expect(Array.isArray(l.rule_ids) && Array.isArray(l.flags)).toBe(true);
      }
      const eligible = out.lines.filter((l) => l.status === "eligible");
      expect(out.totals.allowed_cents).toBe(eligible.reduce((s, l) => s + l.allowed_cents, 0));
      expect(out.totals.held_cents).toBe(
        out.lines.filter((l) => l.status === "held").reduce((s, l) => s + l.requested_cents, 0),
      );
      expect(Object.values(out.totals.by_expense).reduce((s, v) => s + (v ?? 0), 0)).toBe(out.totals.allowed_cents);
      expect(Object.keys(out.checks).sort()).toEqual(["deadline", "minimum_loss", "reporting"]);
    });
  }
});

describe("bill fixture", () => {
  it("lines add up to the bill total and match scan items", () => {
    const bill = read<BillAudit>("fixtures/riverbend-bill.json");
    const scanIds = new Set(read<{ items: { item_id: string }[] }>("fixtures/rowan-mi.scan.json").items.map((i) => i.item_id));
    expect(bill.lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(bill.total_cents);
    expect(bill.lines_sum_cents).toBe(bill.total_cents);
    for (const l of bill.lines) expect(scanIds.has(l.item_id)).toBe(true);
  });
});

describe("national garden data", () => {
  const list = read<JurisdictionSummary[]>("public/data/jurisdictions.json");

  it("lists all 50 states and DC as {st, name, rules, sources}", () => {
    expect(list.map((j) => j.st).sort()).toEqual(STATES.map((s) => s.st).sort());
    for (const j of list) {
      expect(typeof j.name).toBe("string");
      expect(Number.isInteger(j.rules) && Number.isInteger(j.sources)).toBe(true);
    }
  });

  it("matches the law files byte for byte", () => {
    const files = readdirSync(path.join(web, "public/data/law"));
    for (const j of list.filter((x) => x.rules > 0)) {
      expect(files).toContain(`${j.st}.json`);
      const bytes = readFileSync(path.join(web, "public/data/law", `${j.st}.json`));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(j.sha256);
      expect(JSON.parse(bytes.toString("utf8")).rules).toHaveLength(j.rules);
    }
  });

  it("places every state on a distinct tile", () => {
    const tiles = new Set(STATES.map((s) => `${s.row},${s.col}`));
    expect(tiles.size).toBe(51);
  });
});
