// lib/ledger groups scan items under engine lines for the advocate view (app/share). It never does
// money math; these tests run it on the recorded engine output for Rowan's fictional scan
// (fixtures/rowan-mi.scan.json, made by web/scripts/scan-fixtures.py from the seed persona).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRows, earlierRows, groupBeds, notCounted, openQuestions } from "@/lib/ledger";
import type { EngineOutput, ScanItem, ScanResult } from "@/lib/types";

const web = path.resolve(import.meta.dirname, "..");
const scan = JSON.parse(readFileSync(path.join(web, "fixtures/rowan-mi.scan.json"), "utf8")) as ScanResult;
const output = JSON.parse(readFileSync(path.join(web, "fixtures/rowan-mi.output.json"), "utf8")) as EngineOutput;

// The lock change on June 16 (Keyline Lock & Safe), which the survivor leaves out here.
const LOCK = scan.items.find((i) => i.description.startsWith("Keyline Lock"))!.item_id;

// A cost from before the date, with the line the engine gives such a cost.
const early: ScanItem = { ...scan.items[0], item_id: "nessie:early-1", date: "2026-05-02", description: "Clinic visit" };
const earlyOutput: EngineOutput = {
  ...output,
  lines: [
    ...output.lines,
    {
      item_id: early.item_id,
      expense: early.expense,
      status: "out_of_window",
      requested_cents: early.amount_cents,
      allowed_cents: 0,
      rule_ids: [],
      cap_rule_id: null,
      flags: [],
    },
  ],
};

describe("ledger rows and beds", () => {
  const rows = buildRows(scan.items, { [LOCK]: "no" }, output);

  it("marks declined items without engine lines", () => {
    const lock = rows.find((r) => r.item.item_id === LOCK)!;
    expect(lock.status).toBe("declined");
    expect(lock.line).toBeNull();
  });

  it("keeps out-of-window items out of the beds", () => {
    const withEarly = buildRows([...scan.items, early], {}, earlyOutput);
    expect(earlierRows(withEarly).map((r) => r.item.item_id)).toEqual([early.item_id]);
    const beds = groupBeds(withEarly, earlyOutput);
    expect(beds.flatMap((b) => b.rows).some((r) => r.status === "out_of_window")).toBe(false);
  });

  it("orders beds by expense and takes bed totals from the engine", () => {
    const beds = groupBeds(rows, output);
    expect(beds[0].expense).toBe("medical");
    expect(beds[0].allowedCents).toBe(output.totals.by_expense.medical);
    // Rowan's bill: the $75 visit and the $43 lab count; the $325 exam line is held.
    expect(beds[0].allowedCents).toBe(11800);
    expect(beds.find((b) => b.expense === "forensic_exam")?.heldCents).toBe(32500);
  });

  it("counts open questions and lines the law leaves out", () => {
    expect(openQuestions(rows).length).toBeGreaterThan(0);
    const left = notCounted(rows);
    // The new phone (a rule excludes phones) and the prescription copays (no Michigan rule names them).
    expect(new Set(left.map((r) => r.status))).toEqual(new Set(["excluded", "unknown_rule"]));
    expect(left.find((r) => r.status === "excluded")?.item.description).toMatch(/new phone/);
    expect(left.filter((r) => r.status === "unknown_rule").every((r) => r.item.expense === "prescription")).toBe(true);
  });

  it("shows rows as checking until the engine answers", () => {
    expect(buildRows(scan.items, {}, null).every((r) => r.status === "checking")).toBe(true);
  });
});
