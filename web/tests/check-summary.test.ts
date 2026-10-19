// The Check summary (components/flow/checkSummary.ts) on the real verified corpus: every fact it
// shows must point at rules that exist in that state's law file, and of the right kind.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCheckSummary, capText, setAsideIds, type CheckSummary } from "@/components/flow/checkSummary";
import { EMPTY_CHECK, type CheckAnswers } from "@/components/flow/state";
import { formatters } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { es } from "@/lib/i18n/es";
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
    expect(counseling.cap).toEqual({
      cents: 12500,
      per: "session",
      countLimit: 35,
      countUnit: "session",
      varies: true,
    });
    expect(s.covered.find((c) => c.expense === "lost_wages")!.cap).toMatchObject({
      cents: 100000,
      per: "week",
      varies: false,
    });
    expect(s.covered.find((c) => c.expense === "transportation")!.cap).toMatchObject({
      cents: 500000,
      per: "claim",
      varies: true,
    });
    expect(s.covered.find((c) => c.expense === "medical")!.cap).toBeNull();
    expect(s.covered.some((c) => (c.expense as string) === "forensic_exam")).toBe(false);
    expect(s.totalCap).toEqual({ cents: 4500000, ruleIds: ["MI-CAP-1"] });
  });

  // MI-CAP-7 ($1,000) is for trips of 50 miles or less each way and MI-CAP-8 ($5,000) for longer
  // trips to care not available closer: the citation leads with the rule that covers rides.
  it("cites the rule that covers a cost first, then each limit in the law's order", () => {
    const ids = (e: string) => s.covered.find((c) => c.expense === e)!.ruleIds;
    expect(ids("transportation")).toEqual(["MI-COV-7", "MI-CAP-7", "MI-CAP-8"]);
    expect(ids("counseling")).toEqual(["MI-COV-2", "MI-CAP-2", "MI-CAP-3", "MI-CAP-4"]);
    // With no rule that only covers it, the limit is the rule that names the cost.
    expect(ids("clothing_bedding")).toEqual(["MI-CAP-10"]);
    expect(
      capText(
        s.covered.find((c) => c.expense === "transportation")!,
        en,
        formatters("en"),
      ),
    ).toBe("up to $5,000 in total, depending on your case");
    expect(
      capText(
        s.covered.find((c) => c.expense === "transportation")!,
        es,
        formatters("es"),
      ),
    ).toBe("hasta $5,000 en total, según tu caso");
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

describe("caps that only cover one kind of provider", () => {
  it("prefers an overall limit to a rate that may cover one provider type (California counseling)", () => {
    const ca = load("CA");
    const counseling = buildCheckSummary(ca, output(ca), { ...answers, st: "CA" }, true).covered.find(
      (c) => c.expense === "counseling",
    )!;
    // CA-COUNSEL-2 ($15 an hour) is for peer counseling only; the overall limit is $10,000.
    expect(counseling.cap).toEqual({
      cents: 1000000,
      per: "claim",
      countLimit: 60,
      countUnit: "session",
      varies: false,
    });
  });

  it("says how many sessions when the law limits only the count (Texas counseling)", () => {
    const tx = load("TX");
    const counseling = buildCheckSummary(tx, output(tx), { ...answers, st: "TX" }, true).covered.find(
      (c) => c.expense === "counseling",
    )!;
    expect(counseling.cap).toEqual({
      cents: null,
      per: "session",
      countLimit: 60,
      countUnit: "session",
      varies: false,
    });
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
      // What covers the cost comes before its limits.
      const kinds = c.ruleIds.map((id) => byId.get(id)!.category);
      expect(kinds).toEqual([...kinds].sort((a, b) => Number(a === "expense_cap") - Number(b === "expense_cap")));
      if (c.cap?.cents != null) expect(Number.isSafeInteger(c.cap.cents) && c.cap.cents >= 0).toBe(true);
      if (c.cap?.cents == null && c.cap) expect(c.cap.countLimit).toBeGreaterThan(0);
    }
    for (const id of s.records) expect(byId.get(id)!.category).toBe("record_confidentiality");
    for (const id of s.acp?.ruleIds ?? []) expect(byId.get(id)!.category).toBe("address_confidentiality");
    expect(s.name).toBe(law.name);
  });
});

// docs/SPEC.md v1.1: rules whose applies_to names someone other than the survivor are set aside by the
// IR, and the engine never applies them. Check must not show them as the survivor's limits.
describe("rules the law IR sets aside", () => {
  const irDir = path.join(web, "public/data/ir");
  const aside = (st: string) => setAsideIds(JSON.parse(readFileSync(path.join(irDir, `${st}.json`), "utf8")));
  const summary = (st: string) => {
    const law = load(st);
    return buildCheckSummary(law, output(law), { ...answers, st }, true, aside(st));
  };

  it("keeps only rules skipped for applies_to, not lower duplicates or caps without an amount", () => {
    const ids = setAsideIds({
      skipped: [
        { id: "A", reason: 'applies_to "household family members"' },
        { id: "B", reason: "less generous duplicate of C" },
        { id: "D", reason: "expense_cap without amount or expense" },
      ],
    });
    expect([...ids]).toEqual(["A"]);
  });

  it("Connecticut: the $5,000 limit for emotional harm only is not shown as the total", () => {
    const s = summary("CT");
    expect(s.totalCap).toBeNull();
    expect(s.totalCapsDepend.map((c) => c.cents)).toEqual([1500000, 500000]);
  });

  it("Illinois: the older date range's $27,000 is not the total for a crime this year", () => {
    const s = summary("IL");
    expect(s.totalCap).toBeNull();
    expect(s.totalCapsDepend).toEqual([
      { cents: 4500000, ruleIds: ["IL-CAP-1"] },
      { cents: 2700000, ruleIds: ["IL-CAP-2"] },
    ]);
    // Without the IR (it failed to load), the old reading stays: the smallest total.
    expect(buildCheckSummary(load("IL"), output(load("IL")), { ...answers, st: "IL" }, true).totalCap?.cents).toBe(
      2700000,
    );
  });

  it("Idaho and Maryland: a family member's limits and costs are not the survivor's", () => {
    const id = summary("ID");
    expect(id.covered.flatMap((c) => c.ruleIds)).not.toContain("ID-CAP-3");
    const md = summary("MD");
    expect(md.covered.flatMap((c) => c.ruleIds)).not.toContain("MD-COV-10");
    expect(md.covered.flatMap((c) => c.ruleIds)).not.toContain("MD-COV-11");
  });

  it.each(STATES)("%s: no cost or total limit cites a set-aside rule", (st) => {
    const s = summary(st);
    const ids = aside(st);
    const shown = [...s.covered.flatMap((c) => c.ruleIds), ...(s.totalCap?.ruleIds ?? [])];
    expect(shown.filter((id) => ids.has(id))).toEqual([]);
  });
});

// lib/cite.ts: the Check names clothing and bedding with the condition every rule that pays for it
// sets. Read by hand from each rule's quote and summary: MI-CAP-10 pays only for what is "held as
// evidence of a crime"; DC-CAP-8 only for "clothing" held "for evidentiary purposes"; LA, MA, and TX
// also pay for what the investigation made unusable; OH-COV-5 pays for "items of clothing removed from
// a victim in order to make an assessment of possible physical harm or to treat physical harm", and
// WA-COV-CLOTHING for "clothing or footwear" lost or damaged "in the course of emergency medical
// treatment"; NJ-COV-CLOTH's quote is a clause of the crime scene clean-up section (N.J.A.C.
// 13:75-4.12(d)1), and its summary says so ("As part of crime scene clean-up"); the sentences quoted
// for NY set no condition.
describe("clothing and bedding on the Check", () => {
  const irDir = path.join(web, "public/data/ir");
  const summary = (st: string) => {
    const law = load(st);
    const ir = JSON.parse(readFileSync(path.join(irDir, `${st}.json`), "utf8"));
    return buildCheckSummary(law, output(law), { ...answers, st }, true, setAsideIds(ir));
  };
  const CONDITION: Record<string, string | null> = {
    AK: "evidence",
    CT: "evidence",
    IA: "evidence",
    IL: "evidence",
    KS: "evidence",
    MI: "evidence",
    SD: "evidence",
    VA: "evidence",
    WI: "evidence",
    WY: "evidence",
    DC: "evidenceClothing",
    LA: "investigation",
    MA: "investigation",
    TX: "investigation",
    OH: "removedForCare",
    WA: "emergencyCare",
    NJ: "cleanup",
    NY: null,
  };

  it("names the condition each state's rules set, in every state that pays for it", () => {
    const shown: Record<string, string | null> = {};
    for (const st of STATES) {
      const line = summary(st).covered.find((c) => c.expense === "clothing_bedding");
      if (line) shown[st] = line.condition;
    }
    expect(shown).toEqual(CONDITION);
  });

  it("no other kind of cost carries a condition", () => {
    for (const st of STATES) {
      const named = summary(st).covered.filter((c) => c.expense !== "clothing_bedding" && c.condition !== null);
      expect(named.map((c) => `${st} ${c.expense}`)).toEqual([]);
    }
  });
});
