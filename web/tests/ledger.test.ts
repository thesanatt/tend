// lib/ledger groups scan items under engine lines for the advocate view (app/share). It never does
// money math; these tests run it on the recorded engine output for Rowan's fictional scan.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRows, earlierRows, groupBeds, notCounted, openQuestions } from "@/lib/ledger";
import type { EngineOutput, ScanResult } from "@/lib/types";

const web = path.resolve(import.meta.dirname, "..");
const scan = JSON.parse(readFileSync(path.join(web, "fixtures/rowan-mi.scan.json"), "utf8")) as ScanResult;
const output = JSON.parse(readFileSync(path.join(web, "fixtures/rowan-mi.output.json"), "utf8")) as EngineOutput;

const LOCK = "nessie:66a1f0c2e4b0a7d1c3f5a1d2";

describe("ledger rows and beds", () => {
  const rows = buildRows(scan.items, { [LOCK]: "no" }, output);

  it("marks declined items without engine lines", () => {
    const lock = rows.find((r) => r.item.item_id === LOCK)!;
    expect(lock.status).toBe("declined");
    expect(lock.line).toBeNull();
  });

  it("keeps out-of-window items out of the beds", () => {
    expect(earlierRows(rows)).toHaveLength(1);
    const beds = groupBeds(rows, output);
    expect(beds.flatMap((b) => b.rows).some((r) => r.status === "out_of_window")).toBe(false);
  });

  it("orders beds by expense and takes bed totals from the engine", () => {
    const beds = groupBeds(rows, output);
    expect(beds[0].expense).toBe("medical");
    expect(beds[0].allowedCents).toBe(output.totals.by_expense.medical);
    expect(beds.find((b) => b.expense === "forensic_exam")?.heldCents).toBe(32500);
  });

  it("counts open questions and lines the law leaves out", () => {
    expect(openQuestions(rows).length).toBeGreaterThan(0);
    expect(
      notCounted(rows)
        .map((r) => r.status)
        .sort(),
    ).toEqual(["excluded", "unknown_rule"]);
  });

  it("shows rows as checking until the engine answers", () => {
    expect(buildRows(scan.items, {}, null).every((r) => r.status === "checking")).toBe(true);
  });
});
