import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluatePreview } from "@/lib/engine/preview";
import { buildRows, earlierRows, groupBeds, notCounted, openQuestions } from "@/lib/ledger";
import { DEMO, engineInputFrom, type Session } from "@/lib/session";
import type { Jurisdiction, ScanResult } from "@/lib/types";

const web = path.resolve(import.meta.dirname, "..");
const scan = JSON.parse(readFileSync(path.join(web, "fixtures/rowan-mi.scan.json"), "utf8")) as ScanResult;
const mi = JSON.parse(readFileSync(path.join(web, "public/data/law/MI.json"), "utf8")) as Jurisdiction;

const RIDE = "nessie:66a1f0c2e4b0a7d1c3f5a1a0";
const LOCK = "nessie:66a1f0c2e4b0a7d1c3f5a1d2";
const RX = "nessie:66a1f0c2e4b0a7d1c3f5a1b3";

const session = (answers: Session["answers"] = {}): Session => ({
  ...DEMO,
  v: 1,
  consented_at: "2026-10-03T16:00:00Z",
  scan,
  answers,
  life: {},
  payments: [],
  share: null,
});

const evaluate = (s: Session) => evaluatePreview(engineInputFrom(s), mi, "sha");

describe("answers flow into the engine input", () => {
  it("yes confirms, no removes, not sure stays unconfirmed", () => {
    const s = session({ [RIDE]: "yes", [LOCK]: "no", [RX]: "unsure" });
    const input = engineInputFrom(s);
    expect(input.items.find((i) => i.item_id === RIDE)?.confirmed).toBe(true);
    expect(input.items.some((i) => i.item_id === LOCK)).toBe(false);
    expect(input.items.find((i) => i.item_id === RX)?.confirmed).toBe(false);
    expect(input.context).toEqual({
      incident_date: "2026-06-14",
      as_of_date: "2026-10-03",
      police_report: "no",
      forensic_exam: true,
    });
  });

  it("a yes on one ride adds exactly that ride to the total", () => {
    const before = evaluate(session()).totals.allowed_cents;
    const after = evaluate(session({ [RIDE]: "yes" })).totals.allowed_cents;
    expect(after - before).toBe(2340);
  });

  it("an unanswered forensic exam choice is sent as false, never guessed", () => {
    const s = { ...session(), forensic_exam: null };
    expect(engineInputFrom(s).context.forensic_exam).toBe(false);
  });
});

describe("ledger rows and beds", () => {
  const s = session({ [LOCK]: "no" });
  const output = evaluate(s);
  const rows = buildRows(s.scan.items, s.answers, output);

  it("marks declined items without sending them to the engine", () => {
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
    expect(openQuestions(rows)).toHaveLength(7);
    expect(
      notCounted(rows)
        .map((r) => r.status)
        .sort(),
    ).toEqual(["excluded", "unknown_rule"]);
  });

  it("shows rows as checking until the engine answers", () => {
    expect(
      buildRows(s.scan.items, s.answers, null).every((r) => r.status === "checking" || r.status === "declined"),
    ).toBe(true);
  });
});
