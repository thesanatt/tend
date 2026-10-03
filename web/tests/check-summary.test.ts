// The Check summary (components/flow/checkSummary.ts) on the real verified corpus: every fact it
// shows must point at rules that exist in that state's law file, and of the right kind.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCheckSummary, type CheckSummary } from "@/components/flow/checkSummary";
import { EMPTY_CHECK, type CheckAnswers } from "@/components/flow/state";
import type { EngineOutput, Jurisdiction } from "@/lib/types";

const web = path.resolve(import.meta.dirname, "..");
const lawDir = path.join(web, "public/data/law");
const load = (st: string) => JSON.parse(readFileSync(path.join(lawDir, `${st}.json`), "utf8")) as Jurisdiction;
const STATES = readdirSync(lawDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5))
  .sort();

const answers: CheckAnswers = { ...EMPTY_CHECK, st: "MI", date: "2026-06-14", exam: "yes", police: "not_yet" };

function output(
  law: Jurisdiction,
  deadline: Partial<EngineOutput["checks"]["deadline"]> = {},
  reporting: Partial<EngineOutput["checks"]["reporting"]> = {},
): EngineOutput {
  const ids = (c: string) => law.rules.filter((r) => r.category === c).map((r) => r.id);
  return {
    jurisdiction: law.jurisdiction,
    law_image_sha256: "x",
    lines: [],
    totals: { requested_cents: 0, allowed_cents: 0, held_cents: 0, by_expense: {} },
    checks: {
      deadline: { status: "ok", deadline_date: "2031-06-14", rule_ids: ids("filing_deadline"), ...deadline },
      minimum_loss: { status: "met", rule_ids: [] },
      reporting: { status: "satisfied", rule_ids: ids("reporting_requirement"), ...reporting },
    },
    info_rule_ids: [],
    trace: [],
  };
}

function cited(s: CheckSummary): string[] {
  return [
    ...s.apply,
    ...("ruleIds" in s.deadline ? s.deadline.ruleIds : []),
    ...s.reporting.ruleIds,
    ...s.reporting.altRuleIds,
    ...s.examNoBill,
    ...s.examPayer.ruleIds,
    ...s.covered.flatMap((c) => c.ruleIds),
    ...(s.totalCap?.ruleIds ?? []),
    ...(s.acp?.ruleIds ?? []),
    ...s.records,
  ];
}

describe("Check summary for Michigan", () => {
  const mi = load("MI");
  const s = buildCheckSummary(mi, output(mi), answers, true);

  it("cites who can apply, and never says 'you qualify'", () => {
    expect(s.apply.length).toBeGreaterThan(0);
    expect(s.apply.every((id) => mi.rules.find((r) => r.id === id)?.category === "eligible_crime")).toBe(true);
  });

  it("gives the filing deadline as the engine's date", () => {
    expect(s.deadline).toMatchObject({ kind: "date", date: "2031-06-14", late: false, canExtend: true });
  });

  it("says the exam counts in place of a police report, and which alternatives count", () => {
    expect(s.reporting.status).toBe("met_by_exam");
    expect(s.reporting.alternatives).toContain("forensic_exam");
    const reported = buildCheckSummary(mi, output(mi), { ...answers, police: "yes" }, true);
    expect(reported.reporting.status).toBe("met_by_report");
    const required = buildCheckSummary(mi, output(mi, {}, { status: "required" }), answers, true);
    expect(required.reporting.status).toBe("required");
  });

  it("lists covered costs with the most generous caps, the way the engine keeps them", () => {
    const counseling = s.covered.find((c) => c.expense === "counseling")!;
    expect(counseling.cap).toEqual({ cents: 12500, per: "session", countLimit: 35 });
    expect(s.covered.find((c) => c.expense === "lost_wages")!.cap).toMatchObject({ cents: 100000, per: "week" });
    expect(s.covered.find((c) => c.expense === "transportation")!.cap).toMatchObject({ cents: 500000, per: "claim" });
    expect(s.covered.find((c) => c.expense === "medical")!.cap).toBeNull();
    expect(s.covered.some((c) => (c.expense as string) === "forensic_exam")).toBe(false);
    expect(s.totalCap).toEqual({ cents: 4500000, ruleIds: ["MI-CAP-1"] });
  });

  it("names the program contact and the two privacy protections", () => {
    expect(s.program).toMatchObject({ name: "Crime Victim Compensation", phone: "877-251-7373" });
    expect(s.acp).toMatchObject({ programName: "Address Confidentiality Program (ACP)", coversSexualAssault: true });
    expect(s.records).toEqual(["MI-RECCONF-1"]);
    expect(s.examNoBill.length).toBeGreaterThan(0);
  });

  it("without a date, gives the length of time from the rule instead of a date", () => {
    const unsure = buildCheckSummary(mi, output(mi), { ...answers, date: "", dateUnsure: true }, false);
    expect(unsure.deadline).toMatchObject({ kind: "span", years: 5 });
  });

  it("past the deadline, says so and whether the program can extend it", () => {
    const late = buildCheckSummary(mi, output(mi, { status: "late", deadline_date: "2021-06-14" }), answers, true);
    expect(late.deadline).toMatchObject({ kind: "date", late: true, canExtend: true });
  });

  it("explains a deadline counted from the report when the engine flags it (SPEC v1.2)", () => {
    const flagged = output(mi);
    (flagged.checks.deadline as unknown as { flags: string[] }).flags = ["deadline_from_report"];
    expect(buildCheckSummary(mi, flagged, answers, true).deadline).toMatchObject({ fromReport: true });
  });
});

describe("Check summary in every jurisdiction", () => {
  it.each(STATES)("%s: every cited rule exists, with the right category", (st) => {
    const law = load(st);
    const byId = new Map(law.rules.map((r) => [r.id, r]));
    const s = buildCheckSummary(law, output(law), { ...answers, st }, true);
    for (const id of cited(s)) expect(byId.has(id), `${st} cites ${id}`).toBe(true);
    for (const c of s.covered) {
      for (const id of c.ruleIds) expect(["covered_expense", "expense_cap"]).toContain(byId.get(id)!.category);
      if (c.cap) expect(Number.isSafeInteger(c.cap.cents) && c.cap.cents >= 0).toBe(true);
    }
    for (const id of s.records) expect(byId.get(id)!.category).toBe("record_confidentiality");
    for (const id of s.acp?.ruleIds ?? []) expect(byId.get(id)!.category).toBe("address_confidentiality");
    expect(s.name).toBe(law.name);
  });
});
