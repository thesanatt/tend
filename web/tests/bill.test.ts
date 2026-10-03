// The pay action must never offer a held exam line, including before the engine has answered.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { billPlan } from "@/lib/bill";
import type { BillAudit, EngineOutput } from "@/lib/types";

const web = path.resolve(import.meta.dirname, "..");
const read = <T>(p: string) => JSON.parse(readFileSync(path.join(web, p), "utf8")) as T;
const bill = read<BillAudit>("fixtures/riverbend-bill.json");
const output = read<EngineOutput>("fixtures/rowan-mi.output.json");

describe("bill plan", () => {
  it("holds the exam line and leaves the rest to pay once the engine has decided", () => {
    const plan = billPlan(bill, output);
    expect(plan.decided).toBe(true);
    expect(plan.heldCents).toBe(32500);
    expect(plan.restCents + plan.heldCents).toBe(bill.total_cents);
    expect(plan.payLines.every((l) => l.expense !== "forensic_exam")).toBe(true);
    expect(plan.restClaimed).toBe(true);
  });

  it("offers nothing to pay before the engine answers", () => {
    const plan = billPlan(bill, null);
    expect(plan).toMatchObject({ decided: false, restCents: 0, heldCents: 0 });
  });

  it("offers nothing to pay when the output does not cover every bill line", () => {
    const partial = { ...output, lines: output.lines.filter((l) => l.status !== "held") };
    expect(billPlan(bill, partial)).toMatchObject({ decided: false, restCents: 0 });
  });

  it("says when a line left to pay is not in the claim", () => {
    const excluded = {
      ...output,
      lines: output.lines.map((l) =>
        l.item_id === bill.lines[1].item_id ? { ...l, status: "excluded" as const, allowed_cents: 0 } : l,
      ),
    };
    expect(billPlan(bill, excluded).restClaimed).toBe(false);
  });
});
