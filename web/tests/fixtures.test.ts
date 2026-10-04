// Fixtures must keep the exact shapes in docs/SPEC.md (v1.2) so they can be swapped for live data,
// and must be what the engine really says: the outputs are run again here through the WebAssembly
// engine and must match byte for byte. Rebuild them with web/scripts/scan-fixtures.py, then
// `npm run fixtures`.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import STATES from "@/lib/states.json";
import {
  EXPENSES,
  type BillAudit,
  type EngineInput,
  type EngineOutput,
  type JurisdictionSummary,
  type ShareView,
} from "@/lib/types";

const web = path.resolve(import.meta.dirname, "..");
const read = <T>(p: string) => JSON.parse(readFileSync(path.join(web, p), "utf8")) as T;
const isCents = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const STATUSES = ["out_of_window", "held", "excluded", "unknown_rule", "needs_confirmation", "eligible"];
const UNITS = ["session", "week", "hour", "mile", "day", "month", "item", null];
const image = path.join(web, "public/engine/laws/MI.tlaw");
const haveEngine = existsSync(image) && existsSync(path.join(web, "public/engine/tend_engine.mjs"));

describe("engine input fixture", () => {
  const input = read<EngineInput>("fixtures/rowan-mi.input.json");

  it("has exactly the SPEC v1.2 keys", () => {
    expect(Object.keys(input).sort()).toEqual(["context", "items", "jurisdiction"]);
    expect(Object.keys(input.context).sort()).toEqual([
      "as_of_date",
      "forensic_exam",
      "incident_date",
      "police_report",
    ]);
    for (const it of input.items) {
      expect(Object.keys(it).sort()).toEqual(
        [
          "amount_cents",
          "confirmed",
          "date",
          "description",
          "expense",
          "insurance_paid_cents",
          "is_bill",
          "item_id",
          "tags",
          "unit",
          "units",
        ].sort(),
      );
      expect(isCents(it.amount_cents) && isCents(it.insurance_paid_cents)).toBe(true);
      expect([...EXPENSES, "unknown"]).toContain(it.expense);
      const v12 = it as EngineInput["items"][number] & { unit: string | null; tags: string[] };
      expect(UNITS).toContain(v12.unit);
      expect(Array.isArray(v12.tags)).toBe(true);
    }
  });

  it("is Rowan from the seed: the Riverbend bill's three lines, and lost pay counted in days", () => {
    const bill = input.items.filter((i) => i.item_id.startsWith("bill:"));
    expect(bill.map((i) => i.amount_cents).sort((a, b) => a - b)).toEqual([4300, 7500, 32500]);
    expect(bill.reduce((s, i) => s + i.amount_cents, 0)).toBe(44300);
    const pay = input.items.filter((i) => i.expense === "lost_wages") as (EngineInput["items"][number] & {
      unit: string;
    })[];
    expect(pay.map((i) => [i.amount_cents, i.unit, i.units, i.confirmed])).toEqual([
      [17600, "day", 4, false],
      [17600, "day", 4, false],
      [17600, "day", 4, false],
    ]);
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
      // v1.2: the deadline check carries its flags (Michigan counts from the report).
      expect((out.checks.deadline as { flags?: string[] }).flags).toEqual(["deadline_from_report"]);
      // Rowan's numbers, the same everywhere: the $325.00 exam line held, the $118.00 rest counted.
      expect(out.totals.held_cents).toBe(32500);
      expect(out.totals.by_expense.medical).toBe(11800);
    });
  }

  describe.skipIf(!haveEngine)("are what the WebAssembly engine says today", () => {
    async function evaluate(input: EngineInput): Promise<EngineOutput> {
      const { loadTend } = (await import(pathToFileURL(path.join(web, "public/engine/tend_engine.mjs")).href)) as {
        loadTend: () => Promise<{ evaluate: (img: Uint8Array, claim: unknown) => EngineOutput }>;
      };
      return (await loadTend()).evaluate(new Uint8Array(readFileSync(image)), input);
    }

    it("rowan-mi.output.json", async () => {
      const input = read<EngineInput>("fixtures/rowan-mi.input.json");
      expect(await evaluate(input)).toEqual(read<EngineOutput>("fixtures/rowan-mi.output.json"));
    });

    it("share-demo.json", async () => {
      const view = read<ShareView>("fixtures/share-demo.json");
      expect(await evaluate(view.input)).toEqual(view.output);
    });
  });
});

describe("bill fixture", () => {
  it("lines add up to the bill total and match scan items", () => {
    const bill = read<BillAudit>("fixtures/riverbend-bill.json");
    const scanIds = new Set(
      read<{ items: { item_id: string }[] }>("fixtures/rowan-mi.scan.json").items.map((i) => i.item_id),
    );
    expect(bill.lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(bill.total_cents);
    expect(bill.lines_sum_cents).toBe(bill.total_cents);
    for (const l of bill.lines) expect(scanIds.has(l.item_id)).toBe(true);
    // The $443.00 Riverbend General bill, its $325.00 exam line held.
    expect(bill.total_cents).toBe(44300);
    expect(bill.holds.map((h) => h.amount_cents)).toEqual([32500]);
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
