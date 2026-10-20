// The public state summary may say only what the verified rules say, and must cite every line.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASKS_FOR_REPORT,
  buildStateSummary,
  cardSources,
  citedIds,
  clauseText,
  duration,
  EXAM_SOMETIMES,
  expenseName,
  joinWords,
  NEEDS_CHARGE,
  plainMarks,
  SHARE_WORD_LIMIT,
  type StateSummary,
} from "@/components/public/summary";
import type { IrSummary } from "@/components/public/types";
import { formatCentsShort } from "@/lib/money";
import { EXPENSES, type Jurisdiction, type Rule } from "@/lib/types";

const web = path.resolve(import.meta.dirname, "..");
const states = readdirSync(path.join(web, "public/data/law"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5))
  .sort();

function load(st: string): { law: Jurisdiction; ir: IrSummary } {
  return {
    law: JSON.parse(readFileSync(path.join(web, "public/data/law", `${st}.json`), "utf8")),
    ir: JSON.parse(readFileSync(path.join(web, "public/data/ir", `${st}.json`), "utf8")),
  };
}

const built = new Map(states.map((st) => [st, { ...load(st), summary: buildStateSummary(load(st).law, load(st).ir) }]));

// "$25,000" but not the comma after it in "$25,000, or more".
const DOLLARS = /\$\d{1,3}(?:,\d{3})*(?:\.\d\d)?/g;
// Text params the page prints inside its own sentences. verify.py checks every number in them
// against the rule's quote, so an amount written there may be printed too.
const TEXT_PARAMS = ["exception", "condition", "scope", "extension", "exam_condition", "item", "only_benefit_if"];

// Every amount a rule's params name, as the page prints it.
function amounts(rules: Rule[]): Set<string> {
  const out = new Set<string>();
  for (const r of rules) {
    for (const v of Object.values(r.params ?? {})) if (typeof v === "number") out.add(formatCentsShort(v));
    for (const key of TEXT_PARAMS) {
      const v = r.params?.[key];
      if (typeof v === "string") for (const m of v.match(DOLLARS) ?? []) out.add(m);
    }
  }
  out.add(formatCentsShort(0));
  return out;
}

// Rules the normalizer set aside (a lower duplicate cap still counts as a limit).
function setAside(ir: IrSummary): Set<string> {
  return new Set(ir.skipped.filter((s) => !/^less generous duplicate of /.test(s.reason)).map((s) => s.id));
}

function alternatives(r: Rule): string[] {
  return ([] as string[]).concat((r.params?.alternatives as string[] | string | undefined) ?? []);
}

// The reporting rules that answer "does the program need a police report": active, not narrowed by
// a scope, and not a waiver for the forensic exam alone (summary.ts reportSection).
function reportRules(law: Jurisdiction, ir: IrSummary) {
  const aside = setAside(ir);
  const rules = law.rules.filter((r) => r.category === "reporting_requirement" && !aside.has(r.id));
  const main = rules.filter((r) => !r.params?.scope && (r.params?.expense ?? r.expense) !== "forensic_exam");
  const required = main.filter((r) => r.params?.required === true);
  const exam = required.filter((r) => alternatives(r).includes("forensic_exam"));
  const examConditions = new Set(exam.map((r) => r.params?.exam_condition).filter((v) => typeof v === "string"));
  const noOther = required.length > 0 && required.every((r) => !alternatives(r).length);
  // A rule whose own words let the program waive the report after a forensic exam (Iowa r. 61-9.29(4)(c)).
  const examWaiver = required.some((r) =>
    ([] as unknown[]).concat(r.params?.waiver_records ?? []).includes("forensic_exam"),
  );
  return {
    exam,
    examConditions,
    charge: rules.some((r) => r.params?.charge_required === true),
    // Every award needs a report: some required rule, and none names another record, or the other records
    // are ones an anonymous adult cannot get on her own (report_gate, Delaware 9010(a)(5)).
    gate: (noOther && !examWaiver) || (!noOther && required.some((r) => r.params?.report_gate === true)),
    sometimes: noOther && examWaiver,
  };
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
// en dash, em dash, curly quotes, bullet: built from code points so this file stays ASCII
const TYPOGRAPHIC = new RegExp(
  `[${[0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022].map((c) => String.fromCharCode(c)).join("")}]`,
);

function allText(s: StateSummary): string[] {
  return [
    s.share.text,
    ...s.keyFacts.flatMap((k) => [k.big, k.small]),
    ...s.sections.flatMap((x) => [x.title, ...x.facts.flatMap((f) => [f.label ?? "", f.text])]),
  ];
}

// Tend's own wording: everything above except the rules' own summaries.
function templatedText(s: StateSummary): string[] {
  return [
    s.share.text,
    ...s.keyFacts.flatMap((k) => [k.big, k.small]),
    ...s.sections.flatMap((x) => [
      x.title,
      ...x.facts.filter((f) => !f.verbatimSummary).flatMap((f) => [f.label ?? "", f.text]),
    ]),
  ];
}

describe("state summaries for every jurisdiction", () => {
  it("covers all 51", () => {
    expect(states).toHaveLength(51);
  });

  it.each(states)("%s: every law line cites rules or sources that exist", (st) => {
    const { law, summary } = built.get(st)!;
    const ids = new Set([...law.rules.map((r) => r.id), ...law.sources.map((s) => s.id)]);
    for (const section of summary.sections) {
      for (const f of section.facts) {
        if (f.kind === "note") {
          expect(f.cites, f.key).toEqual([]);
          // A page note (jurisdiction field page_notes) is Tend's own note and says so.
          expect(f.text).toMatch(f.key.endsWith("-note") ? /^Note: / : /^Tend has not verified/);
        } else {
          expect(f.cites.length, `${st} ${f.key} has no citation`).toBeGreaterThan(0);
          for (const id of f.cites) expect(ids.has(id), `${st} ${f.key} cites unknown ${id}`).toBe(true);
        }
      }
    }
    for (const id of citedIds(summary)) expect(ids.has(id), `${st} cites unknown ${id}`).toBe(true);
  });

  it.each(states)("%s: templated amounts come from the cited rules' params", (st) => {
    const { law, summary } = built.get(st)!;
    const rules = new Map(law.rules.map((r) => [r.id, r]));
    const check = (text: string, cites: string[], where: string) => {
      const allowed = amounts(cites.map((id) => rules.get(id)).filter((r): r is Rule => !!r));
      for (const m of text.match(DOLLARS) ?? [])
        expect(allowed.has(m), `${st} ${where}: ${m} not in params`).toBe(true);
    };
    for (const section of summary.sections) {
      for (const f of section.facts) {
        if (f.verbatimSummary) {
          // A rule's own summary, unchanged.
          expect(f.cites).toHaveLength(1);
          expect(f.text.replace(/\.$/, "")).toBe(rules.get(f.cites[0])!.summary.trim().replace(/\.$/, ""));
        } else if (f.kind === "law") {
          check(f.text, f.cites, f.key);
        }
        // Lines under a cost are the summaries of rules the line cites.
        for (const d of f.details ?? []) {
          expect(f.cites).toContain(d.cite);
          expect(d.text.replace(/\.$/, "")).toBe(rules.get(d.cite)!.summary.trim().replace(/\.$/, ""));
        }
      }
    }
    for (const k of summary.keyFacts) check(k.big, k.cites, `key ${k.id}`);
    for (const c of summary.share.clauses) check(c.text, c.cites, `share ${c.id}`);
  });

  it.each(states)("%s: share line has the Jane Doe form and one to three cited clauses", (st) => {
    const { summary } = built.get(st)!;
    expect(summary.share.text.startsWith(`If you're Jane Doe in ${summary.place}: `)).toBe(true);
    expect(summary.share.text.endsWith(".")).toBe(true);
    expect(summary.share.clauses.length).toBeGreaterThanOrEqual(1);
    expect(summary.share.clauses.length).toBeLessThanOrEqual(3);
    // A third clause only follows a report or charge clause, and it is the exam.
    if (summary.share.clauses.length === 3) {
      expect([ASKS_FOR_REPORT, NEEDS_CHARGE]).toContain(summary.share.clauses[1].text);
      expect(summary.share.clauses[2].id).toBe("exam");
    }
    // The card image joins the clauses with the same helper, so the page and the card read alike.
    expect(summary.share.text).toBe(`If you're Jane Doe in ${summary.place}: ${clauseText(summary.share.clauses)}`);
    for (const c of summary.share.clauses) expect(c.cites.length).toBeGreaterThan(0);
  });

  it.each(states)("%s: no em dashes, en dashes, curly quotes, or bullets in generated text", (st) => {
    for (const text of allText(built.get(st)!.summary)) expect(TYPOGRAPHIC.test(text), text).toBe(false);
  });

  it.each(states)("%s: the share total is the smallest total cap the engine applies", (st) => {
    const { law, ir, summary } = built.get(st)!;
    const caps = ir.rules.filter((r) => r.kind === "total_cap");
    const total = summary.share.clauses.find((c) => c.id === "total");
    if (!caps.length) {
      expect(total).toBeUndefined();
      return;
    }
    const min = Math.min(...caps.map((r) => r.cap_cents!));
    const lead = caps.filter((r) => r.cap_cents === min).map((r) => law.rules.find((x) => x.id === r.id)!);
    // A dated or conditioned total does not fit the card; the covered costs take its place.
    if (lead.some((r) => r.params?.condition)) {
      expect(total).toBeUndefined();
      return;
    }
    // The hedge comes from the lead cap's exception, or from another total cap for the survivor that
    // states a higher tier or an added award in its own words (AR-CAP-2, WY-CAP-10, MD-CAP-8).
    const aside = setAside(ir);
    const higher = law.rules.filter(
      (r) =>
        r.category === "total_cap" &&
        !lead.includes(r) &&
        !r.params?.applies_to &&
        (typeof r.params?.amount_cents !== "number" || (r.params.amount_cents > min && !aside.has(r.id))),
    );
    const more = [...lead, ...higher].some((r) => r.params?.exception) ? ", or more in some cases" : "";
    // A cost that is the only one some survivors can get says whom the total is for (FL-COV-1).
    const only = law.rules.find(
      (r) => r.category === "covered_expense" && r.params?.only_benefit_if && r.params?.total_condition,
    );
    const who = only ? ` ${String(only.params!.total_condition)}` : "";
    expect(total?.text).toBe(`you can ask for up to ${formatCentsShort(min)}${who}${more}`);
  });

  it.each(states)("%s: the card's report clause follows the report rules", (st) => {
    const { law, ir, summary } = built.get(st)!;
    const { exam, examConditions, charge, gate, sometimes } = reportRules(law, ir);
    const report = summary.share.clauses.find((c) => c.id === "report");
    if (gate) {
      // Every award needs a police report, so the card says that instead of naming a protection.
      expect(report?.text).toBe(ASKS_FOR_REPORT);
    } else if (sometimes) {
      // The program may waive the report after a forensic exam: the card says so when it has room.
      if (report) expect(report.text).toBe(EXAM_SOMETIMES);
      else
        expect(
          words(`If you're Jane Doe in ${summary.place}: ${summary.share.clauses[0].text}, and ${EXAM_SOMETIMES}.`),
        ).toBeGreaterThan(SHARE_WORD_LIMIT);
    } else if (exam.length && charge) {
      // A criminal charge an exam cannot replace takes the second slot (WV-REP-2).
      expect(report?.text).toBe(NEEDS_CHARGE);
    } else if (exam.length && !charge && examConditions.size <= 1) {
      const ec = [...examConditions][0];
      const text = `a forensic exam${ec ? ` ${ec}` : ""} can count instead of a police report`;
      if (report) expect(report.text).toBe(text);
      // Left out only when the sentence would run past the card's word limit.
      else
        expect(
          words(`If you're Jane Doe in ${summary.place}: ${summary.share.clauses[0].text}, and ${text}.`),
        ).toBeGreaterThan(SHARE_WORD_LIMIT);
    } else {
      expect(report).toBeUndefined();
    }
  });

  it.each(states)("%s: the deadline sentence matches its rule", (st) => {
    const { law, summary } = built.get(st)!;
    const fact = summary.sections.flatMap((s) => s.facts).find((f) => f.key === "deadline");
    if (!fact) return;
    const rule = law.rules.find((r) => r.id === fact.cites[0])!;
    expect(fact.text.startsWith(`Apply within ${duration(rule)!.text} of the date it happened`)).toBe(true);
  });

  it.each(states)("%s: no templated sentence says never", (st) => {
    for (const text of templatedText(built.get(st)!.summary)) expect(text, text).not.toMatch(/\bnever\b/i);
  });

  it.each(states)("%s: the exam tile says $0 only when every exam rule behind it is unconditional", (st) => {
    const { law, ir, summary } = built.get(st)!;
    const aside = setAside(ir);
    const active = (category: string) => law.rules.filter((r) => r.category === category && !aside.has(r.id));
    const narrowed = [
      ...active("exam_no_bill").filter((r) => r.params?.scope || r.params?.condition),
      ...active("exam_payment").filter((r) => r.params?.condition),
    ];
    const exam = summary.keyFacts.find((k) => k.id === "exam");
    if (exam) expect(exam.big === formatCentsShort(0), narrowed.map((r) => r.id).join(", ")).toBe(!narrowed.length);
    if (narrowed.length) for (const text of templatedText(summary)) expect(text).not.toMatch(/\$0(?![\d,])/);
  });

  it.each(states)("%s: the card names only costs that no scope narrows", (st) => {
    const { law, summary } = built.get(st)!;
    const covered = summary.share.clauses.find((c) => c.id === "covered");
    if (!covered) return;
    const rules = new Map(law.rules.map((r) => [r.id, r]));
    const plainNames = new Set(EXPENSES.map((e) => expenseName(e).toLowerCase()));
    const named = covered.text.replace(/^you can ask to be paid back for costs like /, "").split(/, and | and |, /);
    for (const name of named) expect(plainNames.has(name), name).toBe(true);
    for (const id of covered.cites) {
      const r = rules.get(id)!;
      if (r.category === "covered_expense") expect(r.params?.scope, id).toBeFalsy();
    }
  });

  it.each(states)("%s: the card footer calls its source law only when every rule behind the card is law", (st) => {
    const { law, summary } = built.get(st)!;
    const kinds = new Map(law.sources.map((s) => [s.id, s.kind]));
    const rules = new Map(law.rules.map((r) => [r.id, r]));
    const isLaw = summary.share.clauses
      .flatMap((c) => c.cites)
      .map((id) => ["statute", "regulation"].includes(kinds.get(rules.get(id)!.source_id) ?? ""));
    const { label, pinpoints } = cardSources(law, summary.share.clauses);
    if (isLaw.every(Boolean)) expect(label).toBe("law");
    else expect(label).toBe(isLaw.some(Boolean) ? "law and program pages" : "program pages");
    expect(pinpoints).toEqual([...new Set(summary.share.clauses.map((c) => rules.get(c.cites[0])!.pinpoint))]);
  });
});

describe("Michigan, the demo state", () => {
  const { summary } = built.get("MI")!;
  const facts = summary.sections.flatMap((s) => s.facts);

  it("reads like the share card in docs/UX.md", () => {
    expect(summary.share.text).toBe(
      "If you're Jane Doe in Michigan: you can ask for up to $45,000, and a forensic exam can count instead of a police report.",
    );
    expect(summary.share.clauses.map((c) => c.cites)).toEqual([["MI-CAP-1"], ["MI-REPORT-1", "MI-REPORT-3"]]);
  });

  it("leads with the four key facts, each cited", () => {
    expect(summary.keyFacts.map((k) => [k.big, k.cites[0]])).toEqual([
      ["$45,000", "MI-CAP-1"],
      ["5 years", "MI-FILE-1"],
      ["Exam can count", "MI-REPORT-1"],
      ["$0", "MI-EXAM-1"],
    ]);
  });

  it("shows each counseling limit with its own conditions", () => {
    const counseling = facts.find((f) => f.label === "Counseling")!;
    expect(counseling.cites).toEqual(["MI-COV-2", "MI-CAP-2", "MI-CAP-3", "MI-CAP-4"]);
    expect(counseling.details!.map((d) => d.cite)).toEqual(["MI-CAP-2", "MI-CAP-3", "MI-CAP-4"]);
    expect(counseling.details![0].text).toMatch(/therapist or counselor .* \$80 per hourly session/);
    expect(counseling.details![1].text).toMatch(/psychologist or physician .* \$125 per hourly session/);
    // A cost with no limit is just named.
    expect(facts.find((f) => f.label === "Medical care")).toMatchObject({ text: "", cites: ["MI-COV-1"] });
  });

  it("says what the exam rules say, no more", () => {
    // MI-EXAM-1 bars billing the victim; MI-EXAM-2 sends a claim to the victim's insurer only with
    // written consent. Neither has a scope or condition, so the tile keeps $0, and no line says "never".
    const exam = summary.sections.find((s) => s.id === "exam")!.facts;
    expect(exam.slice(0, 2).map((f) => [f.text, f.cites])).toEqual([
      ["You should not have to pay for a sexual assault forensic exam.", ["MI-EXAM-1", "MI-EXAM-2"]],
      ["Your insurance can be billed for it only if you agree.", ["MI-EXAM-2"]],
    ]);
    expect(summary.keyFacts.find((k) => k.id === "exam")?.small).toBe("what the forensic exam itself should cost you");
    // MI-FILE-2 (minors) and MI-FILE-3 (good cause) follow the headline as their own rules.
    expect(facts.find((f) => f.key === "deadline")?.text).toBe(
      "Apply within 5 years of the date it happened. The rules below cover other cases.",
    );
    expect(summary.keyFacts.find((k) => k.id === "deadline")?.small).toBe(
      "to apply, from the date it happened, with exceptions",
    );
  });

  it("names law and program pages under the card, since MI-REPORT-3 is the program's page", () => {
    expect(cardSources(built.get("MI")!.law, summary.share.clauses)).toEqual({
      pinpoints: ["MCL 18.361(1)", "MCL 18.355a(10)"],
      label: "law and program pages",
    });
  });

  it("cites the program phone to the page it came from", () => {
    expect(summary.phone).toMatchObject({ text: "877-251-7373", cites: ["MI-S9"], href: "tel:8772517373" });
  });

  it("shows the privacy laws that keep a survivor anonymous with the state", () => {
    const privacy = summary.sections.find((s) => s.id === "privacy")!;
    expect(privacy.facts.map((f) => f.cites[0])).toEqual(["MI-ACP-1", "MI-RECCONF-1"]);
  });

  it("lists every filing route as written, with links where they work", () => {
    const apply = summary.sections.find((s) => s.id === "apply")!;
    expect(apply.facts.map((f) => [f.label, f.href ?? null])).toEqual([
      ["Email", "mailto:MDHHS-MichiganCrimeVictim@Michigan.gov"],
      ["Mail", null],
      ["Fax", null],
      ["Phone", "tel:8772517373"],
    ]);
  });
});

describe("other states", () => {
  it("Illinois has no unconditional total cap, so the card names covered costs instead", () => {
    const { summary } = built.get("IL")!;
    expect(summary.share.clauses[0].id).toBe("covered");
    expect(summary.share.text).toMatch(/^If you're Jane Doe in Illinois: you can ask to be paid back for costs like /);
    const costs = summary.sections.find((s) => s.id === "costs")!;
    expect(costs.facts.slice(0, 2).map((f) => f.cites[0])).toEqual(["IL-CAP-1", "IL-CAP-2"]);
  });

  it("Texas needs a police report for every award, so the card says so instead of naming the exam", () => {
    // TX-REPORT-2 (no report for Emergency Medical Care) is narrower, so it shows in its own words.
    const { summary } = built.get("TX")!;
    expect(summary.share.clauses.map((c) => c.id)).toEqual(["total", "report"]);
    expect(summary.share.text).toBe(
      "If you're Jane Doe in Texas: you can ask for up to $50,000, or more in some cases, and the program asks for a police report.",
    );
    expect(summary.keyFacts.find((k) => k.id === "report")?.big).toBe("Police report");
    const police = summary.sections.find((s) => s.id === "police")!.facts;
    expect(police.find((f) => f.cites[0] === "TX-REPORT-2")?.verbatimSummary).toBe(true);
  });

  it("Kansas does not say a report is simply not required, since it needs a report or an exam", () => {
    // KS-REP-1: a report within 72 hours, OR an exam within seven days, OR good cause. Stored as
    // required with the exam as an alternative, so the tile and the card carry the exam's window.
    const ks = built.get("KS")!.summary;
    const lead = ks.sections.find((s) => s.id === "police")!.facts[0];
    expect(lead.text).toBe(
      "The program asks that the crime be reported. The rules below say what can count besides a police report, like a forensic exam.",
    );
    expect(lead.cites).toContain("KS-REP-1");
    expect(ks.keyFacts.find((k) => k.id === "report")).toMatchObject({
      big: "Exam can count",
      small: "in place of a police report, if it was done within seven days",
    });
    expect(ks.share.text).toBe(
      "If you're Jane Doe in Kansas: you can ask for up to $25,000, and a forensic exam done within seven days can count instead of a police report.",
    );
    for (const { summary } of built.values()) {
      for (const text of allText(summary)) expect(text).not.toMatch(/police report is not required\. The rules below/);
    }
  });

  it("DC is named DC on the card", () => {
    expect(built.get("DC")!.summary.share.text).toMatch(/^If you're Jane Doe in DC: /);
  });

  it("Kentucky has no verified deadline, and the page says so as Tend's note", () => {
    const deadline = built.get("KY")!.summary.sections.find((s) => s.id === "deadline")!;
    expect(deadline.facts).toEqual([expect.objectContaining({ kind: "note", cites: [] })]);
  });

  it("leads with the program's general deadline, not a window for older crimes", () => {
    // Virginia: 3 years for crimes since July 1, 2025. The 1-year rule (VA-DEADLINE-3) covers only
    // crimes from 2001 through June 2025, so it must not be the headline.
    const va = built.get("VA")!.summary;
    expect(va.keyFacts.find((k) => k.id === "deadline")).toMatchObject({ big: "3 years" });
    expect(va.keyFacts.find((k) => k.id === "deadline")?.cites[0]).toBe("VA-DEADLINE-1");
    const vaDeadline = va.sections.find((s) => s.id === "deadline")!;
    expect(vaDeadline.facts[0].text).toBe(
      "Apply within 3 years of the date it happened. The rules below cover other cases.",
    );
    expect(vaDeadline.facts.map((f) => f.cites[0])).toContain("VA-DEADLINE-3");
  });

  it("every headline deadline is the first rule counted from the day it happened", () => {
    const fromIncident = new Set(["crime", "incident", "injury", "offense", "occurrence"]);
    for (const [st, { law, summary }] of built) {
      const first = law.rules.find(
        (r) =>
          r.category === "filing_deadline" &&
          fromIncident.has(String((r.params as Record<string, unknown>)?.from ?? "")) &&
          duration(r) !== null,
      );
      const key = summary.keyFacts.find((k) => k.id === "deadline");
      if (!first) {
        expect(key, st).toBeUndefined();
        continue;
      }
      // The headline rule first; the rules that make "with exceptions" true follow it.
      expect(key?.cites[0], st).toBe(first.id);
      expect(key?.big, st).toBe(duration(first)!.text);
    }
  });

  it("leads with the general deadline and lists the longer windows as their own rules", () => {
    // Florida: 3 years for newer crimes; 5 only with good cause or a DNA delay.
    const fl = built.get("FL")!.summary;
    expect(fl.keyFacts.find((k) => k.id === "deadline")).toMatchObject({ big: "3 years" });
    expect(fl.keyFacts.find((k) => k.id === "deadline")?.cites[0]).toBe("FL-DEADLINE-1");
    const flDeadline = fl.sections.find((s) => s.id === "deadline")!;
    expect(flDeadline.facts.map((f) => f.cites[0])).toContain("FL-DEADLINE-3");
    // Kansas: 5 years, and the board may accept 10 for a sexually violent crime.
    expect(built.get("KS")!.summary.keyFacts.find((k) => k.id === "deadline")?.big).toBe("5 years");
  });

  it("shows a program phone only with the page it came from", () => {
    for (const { law, summary } of built.values()) {
      if (!summary.phone) continue;
      expect(summary.phone.cites).toEqual([law.program.phone_source_id]);
    }
  });

  it("Nevada's 60 months reads as 5 years", () => {
    expect(built.get("NV")!.summary.keyFacts.find((k) => k.id === "deadline")?.big).toBe("5 years");
  });

  it("filing targets keep their words but lose typographic marks", () => {
    const or = built.get("OR")!.summary.sections.find((s) => s.id === "apply")!;
    expect(or.facts.map((f) => f.text).join(" ")).toContain("97301-4096");
    expect(plainMarks(`A ${String.fromCharCode(0x2022)} B${String.fromCharCode(0x2019)}s`)).toBe("A, B's");
  });
});

// Each limit a rule's params carry (condition, scope, exception, extension) reaches every line that
// cites the rule, checked on states where the corpus has one.
describe("limits in the rules reach the page and the card", () => {
  const get = (st: string) => built.get(st)!.summary;
  const fact = (st: string, key: string) =>
    get(st)
      .sections.flatMap((s) => s.facts)
      .find((f) => f.key === key);
  const tile = (st: string, id: string) => get(st).keyFacts.find((k) => k.id === id);

  it("an exam rule's condition follows the exam everywhere it is named (Alaska: 16 or older)", () => {
    // AS 18.68.040 protects a survivor "who is 16 years of age or older".
    expect(fact("AK", "exam-no-bill")).toMatchObject({
      text: "You should not have to pay for a sexual assault forensic exam if you are 16 or older.",
      cites: ["AK-EXAM-1", "AK-EXAM-2"],
      details: [expect.objectContaining({ cite: "AK-EXAM-1" })],
    });
    expect(tile("AK", "exam")).toMatchObject({
      big: "Forensic exam",
      small: "you should not have to pay for it if you are 16 or older",
    });
    // The statute does not say whether insurance may be billed, so there is no insurance line.
    expect(fact("AK", "exam-insurance-prohibited")).toBeUndefined();
  });

  it("a condition on a payment rule narrows the exam line and is cited first (Maryland: 15 days)", () => {
    expect(tile("MD", "exam")).toMatchObject({
      small: "you should not have to pay for it if done within 15 days of the assault",
      cites: ["MD-EXAM-3", "MD-EXAM-1", "MD-EXAM-5"],
    });
    // 11-811(b)(4) holds "except as provided in item (1)(ii)" (MD-CAP-8), so the total is hedged and the
    // exam clause would run past the card's 32 words; it is left out, not shortened.
    expect(get("MD").share.text).toBe(
      "If you're Jane Doe in Maryland: you can ask for up to $45,000, or more in some cases.",
    );
  });

  it("a scope says which part of the exam is free (Texas, Colorado)", () => {
    expect(fact("TX", "exam-no-bill")?.text).toBe(
      "You should not have to pay for the forensic part of an exam or the evidence kit.",
    );
    expect(tile("CO", "exam")?.small).toBe("you should not have to pay for the evidence part of a forensic exam");
  });

  it("a bar or consent rule's own condition starts its insurance line (Wisconsin 949.26(2)(b))", () => {
    expect(fact("WI", "exam-insurance-consent_required")).toMatchObject({
      text: "If the provider bills the state SAFE Fund, your insurance can be billed for it only if you agree.",
      cites: ["WI-EXAM-2"],
    });
  });

  it("the consent and bar lines name private health insurance only where the rules do", () => {
    // New York's rules speak of private insurance; New Hampshire bills Medicaid and Medicare with no
    // choice (NH-EXAM-8, Jus 605.13(c)(3)), so its consent covers private insurance only.
    for (const st of ["NH", "NY"])
      expect(fact(st, "exam-insurance-consent_required")?.text, st).toBe(
        "Your private health insurance can be billed for it only if you agree.",
      );
    // Michigan's "insurance carrier", Minnesota's "insurer", Massachusetts's "primary health insurance":
    // the consent covers any insurance, so the line does not narrow it to private coverage.
    for (const st of ["MA", "MI", "MN"])
      expect(fact(st, "exam-insurance-consent_required")?.text, st).toBe(
        "Your insurance can be billed for it only if you agree.",
      );
    // Mississippi R. 602(3) bars billing "The victim's private insurance" only.
    expect(fact("MS", "exam-insurance-prohibited")?.text).toBe(
      "The provider should not bill your private health insurance for it either.",
    );
    expect(fact("KS", "exam-insurance-prohibited")?.text).toBe(
      "The provider should not bill your insurance for it either.",
    );
  });

  it("a report rule's exception follows the window, and each rule that holds one is cited (Arizona, New Jersey)", () => {
    expect(tile("AZ", "report")).toMatchObject({
      big: "Police report",
      small:
        "the program asks for one within 72 hours, counted from when the crime was discovered, or later if the Board finds good cause",
      cites: ["AZ-REP-1", "AZ-REP-2"],
    });
    expect(tile("NJ", "report")).toMatchObject({
      small:
        "the program asks for one within 9 months, counted from the crime or from when it was reasonably discovered, or later for good cause",
    });
    // The timed rule and the rules holding exceptions first, then every other rule that sets the requirement.
    expect(tile("NJ", "report")?.cites.slice(0, 2)).toEqual(["NJ-REPORT-1", "NJ-REPORT-2"]);
    expect(tile("AK", "report")?.small).toBe(
      "the program asks for one within 5 days, or, if you could not reasonably report that soon, within 5 days of when you could",
    );
  });

  it("where every award needs a police report, the card says so (Alaska, Wyoming)", () => {
    for (const st of ["AK", "WY"]) {
      expect(
        get(st).share.clauses.map((c) => c.id),
        st,
      ).toEqual(["total", "report"]);
      expect(get(st).share.text.endsWith(", and the program asks for a police report."), st).toBe(true);
    }
  });

  it("an exam that counts for the report carries its own limit and cites the text that says so", () => {
    expect(get("RI").share.clauses[1].text).toBe(
      "a forensic exam done within 15 days of the crime can count instead of a police report",
    );
    expect(tile("OK", "report")?.small).toBe("in place of a police report, if it was within 120 hours");
    // With the shorter phrase the exam-counts clause fits the card (32 words).
    expect(get("OK").share.clauses.map((c) => c.id)).toEqual(["total", "report"]);
    // Illinois 6.1(b-1), stored as a waiver, is the sentence that makes the exam count.
    expect(tile("IL", "report")?.cites[0]).toBe("IL-REPORT-2");
    expect(get("IL").share.clauses.find((c) => c.id === "report")?.cites[0]).toBe("IL-REPORT-2");
  });

  it("a total cap's exception hedges the line, the tile and the card (Delaware)", () => {
    expect(fact("DE", "total")?.text).toBe(
      "The most the program can pay in total is $25,000, or up to $50,000 if you are left fully and permanently disabled.",
    );
    expect(tile("DE", "total")?.small).toBe("the most you can ask for in total, except in some cases");
    expect(get("DE").share.clauses[0].text).toBe("you can ask for up to $25,000, or more in some cases");
  });

  it("a total cap with a condition stays off the card, which names covered costs instead (Tennessee)", () => {
    expect(fact("TN", "total")?.text).toBe(
      "The most the program can pay in total is $34,100, for a crime on or after July 1, 2025.",
    );
    expect(get("TN").share.clauses[0].id).toBe("covered");
  });

  it("says when exam payments sit outside the total, and when one cost is all some survivors can get", () => {
    for (const [st, id] of [
      ["MA", "MA-EXAM-6"],
      ["VA", "VA-EXAM-7"],
    ])
      expect(fact(st, "total-outside"), st).toMatchObject({
        text: "Payments for the forensic exam do not count toward this limit.",
        cites: [id],
      });
    expect(fact("FL", "costs-only-FL-COV-1")?.text).toBe(
      "If you are an adult and were not physically hurt, counseling is the only cost the program can pay.",
    );
  });

  it("a deadline's extension joins the headline as a clause or follows it as a sentence", () => {
    expect(fact("AL", "deadline")?.text).toBe(
      "Apply within 1 year of the date it happened, or later if the Commission finds good cause.",
    );
    expect(fact("DC", "deadline")?.text).toBe(
      "Apply within 1 year of the date it happened. If you learned of the program later, you may have 1 year from then if the delay was reasonable. The rules below say more.",
    );
    expect(tile("AL", "deadline")?.small).toBe("to apply, from the date it happened, with exceptions");
    // No extension and no other deadline rule: no hedge.
    expect(tile("LA", "deadline")?.small).toBe("to apply, from the date it happened");
    expect(fact("FL", "deadline")?.text).toBe(
      "Apply within 3 years of the date it happened, for a crime on or after October 1, 2019. The rules below cover other cases.",
    );
  });

  it("a deadline counted from discovery is never the headline (Arizona, Maryland, Pennsylvania)", () => {
    for (const st of ["AZ", "MD", "PA"]) {
      expect(tile(st, "deadline"), st).toBeUndefined();
      expect(
        get(st)
          .sections.find((s) => s.id === "deadline")!
          .facts.filter((f) => f.kind === "law")
          .every((f) => f.verbatimSummary),
        st,
      ).toBe(true);
    }
    // Where the headline rule's own quote also starts the period at discovery, its extension says so.
    expect(fact("MO", "deadline")?.text).toBe(
      "Apply within 2 years of the date it happened, or within 2 years of when the crime was discovered.",
    );
  });

  it("set-aside deadlines, exam-only waivers and cooperation rules still show in their own words (Mississippi)", () => {
    const ms = get("MS");
    const ids = (id: string) => ms.sections.find((s) => s.id === id)!.facts.map((f) => f.cites[0]);
    expect(ids("deadline")).toEqual(["MS-DEADLINE-1", "MS-DEADLINE-2"]);
    expect(ids("police")).toEqual(expect.arrayContaining(["MS-REPORT-3", "MS-CONDUCT-2", "MS-CONDUCT-3"]));
    expect(tile("MS", "deadline")?.small).toBe("to apply, from the date it happened, with exceptions");
  });

  it("a deadline for one travel request shows after the application's deadlines (Washington)", () => {
    const wa = get("WA").sections.find((s) => s.id === "deadline")!.facts;
    expect(wa[0].cites).toEqual(["WA-DEADLINE-1"]);
    expect(wa.at(-1)?.cites).toEqual(["WA-COV-TRANSPORT-3"]);
  });

  it("a cost row narrowed by one scope takes the scope as its name and stays off the card (Alabama)", () => {
    const costs = get("AL").sections.find((s) => s.id === "costs")!.facts;
    expect(costs.find((f) => f.cites[0] === "AL-COV-TRAVEL-MED")?.label).toBe(
      "Travel for medical and psychological treatment needed because of the crime",
    );
    expect(get("AL").share.text).not.toMatch(/travel/i);
  });

  it("a cost row with two scopes keeps its name and shows each rule's own words (Florida travel)", () => {
    const travel = get("FL")
      .sections.find((s) => s.id === "costs")!
      .facts.find((f) => f.label === "Travel")!;
    expect(travel.details!.map((d) => d.cite)).toEqual(["FL-COV-3", "FL-COV-4"]);
  });

  it("the card's covered costs cite each row's limits first (Iowa Code 915.86(1))", () => {
    const ia = get("IA");
    expect(ia.share.clauses[0]).toMatchObject({
      id: "covered",
      text: "you can ask to be paid back for costs like medical care and travel",
    });
    expect(ia.share.clauses[0].cites[0]).toBe("IA-MED-1");
    // The report clause cites the rule that lets the program waive the report after an exam.
    expect(cardSources(built.get("IA")!.law, ia.share.clauses)).toEqual({
      pinpoints: ["Iowa Code 915.86(1)", "Iowa Admin. Code r. 61-9.29(4)(c)"],
      label: "law",
    });
  });

  it("the privacy title says only what its rules cover, and a note says what is missing", () => {
    const privacy = (st: string) => get(st).sections.find((s) => s.id === "privacy")!;
    expect(privacy("AZ").title).toBe("Keeping your address private");
    expect(privacy("AZ").facts.at(-1)?.key).toBe("privacy-records-none");
    expect(privacy("AL").title).toBe("Keeping your claim records private");
    expect(privacy("AL").facts.at(-1)?.key).toBe("privacy-address-none");
    expect(privacy("MI").title).toBe("Keeping your name and address private");
  });

  it("a filing route says who may use it and comes after the others (Virginia's WebFile)", () => {
    const apply = get("VA").sections.find((s) => s.id === "apply")!.facts;
    expect(apply.map((f) => f.label)).toEqual(["Mail", "Fax", "In person", "Online", "Phone"]);
    expect(apply.find((f) => f.label === "Online")?.text).toBe("WebFile (for victim advocates with special training)");
    // A mail line with no address is left out (Colorado's "the appropriate administrator").
    expect(
      get("CO")
        .sections.find((s) => s.id === "apply")!
        .facts.map((f) => f.label),
    ).toEqual(["Phone"]);
  });
});

// The topic verifiers' second round: each case is a line that said more, or less, than its rules.
describe("conditions the second review found missing", () => {
  const get = (st: string) => built.get(st)!.summary;
  const section = (st: string, id: string) => get(st).sections.find((s) => s.id === id)!.facts;
  const tile = (st: string, id: string) => get(st).keyFacts.find((k) => k.id === id);

  it("a higher tier or an added award in another total cap hedges the total and is cited after the lead", () => {
    // Arkansas 16-90-716(a)(2), Wyoming 1-40-109(e), Maryland 11-811(b)(1)(ii).
    expect(section("AR", "costs")[0]).toMatchObject({
      text: "The most the program can pay in total is $10,000, or up to $25,000 if an injury leaves you fully disabled for life.",
      cites: ["AR-CAP-1", "AR-CAP-2"],
    });
    // The tier's own words are not repeated under the line.
    expect(section("AR", "costs").some((f) => f.key === "total-AR-CAP-2")).toBe(false);
    expect(section("WY", "costs")[0].text).toBe(
      "The most the program can pay in total is $15,000, or up to $10,000 more for a catastrophic injury.",
    );
    expect(tile("WY", "total")).toMatchObject({
      small: "the most you can ask for in total, except in some cases",
      cites: ["WY-CAP-1", "WY-CAP-10"],
    });
    for (const st of ["AR", "WY", "MD", "LA", "NJ"])
      expect(get(st).share.clauses[0].text, st).toMatch(/^you can ask for up to \$[\d,]+, or more in some cases$/);
  });

  it("the total says whom it is for when one cost is all some survivors can get (Florida)", () => {
    expect(tile("FL", "total")).toMatchObject({
      small: "the most you can ask for in total if you were physically hurt, except in some cases",
      cites: ["FL-CAP-1", "FL-COV-1"],
    });
    expect(get("FL").share.text).toBe(
      "If you're Jane Doe in Florida: you can ask for up to $15,000 if you were physically hurt, or more in some cases, and the program asks for a police report.",
    );
  });

  it("a criminal charge an exam cannot replace takes the card's second slot (West Virginia)", () => {
    expect(get("WV").share.text).toBe(
      "If you're Jane Doe in West Virginia: you can ask for up to $35,000, or more in some cases, and the program generally needs a criminal charge to be filed.",
    );
    expect(get("WV").share.clauses[1]).toMatchObject({ id: "report", text: NEEDS_CHARGE });
    expect(get("WV").share.clauses[1].cites[0]).toBe("WV-REP-2");
    expect(cardSources(built.get("WV")!.law, get("WV").share.clauses).pinpoints).toEqual([
      "W. Va. Code 14-2A-14(g)(1)",
      "W. Va. Code 14-2A-18",
    ]);
  });

  it("where every award needs a report, the exam still follows it when the card has room", () => {
    expect(get("AL").share.text).toBe(
      "If you're Jane Doe in Alabama: you can ask for up to $15,000, the program asks for a police report, and you should not have to pay for a forensic exam.",
    );
    for (const st of ["AL", "MT", "WA"])
      expect(
        get(st).share.clauses.map((c) => c.id),
        st,
      ).toEqual(["total", "report", "exam"]);
    // No room: the gate alone (Texas).
    expect(get("TX").share.clauses.map((c) => c.id)).toEqual(["total", "report"]);
  });

  it("the police lead asks only that the crime be reported where other records count as the report", () => {
    for (const st of ["GA", "MO"])
      expect(section(st, "police")[0].text, st).toMatch(
        /^The program asks that the crime be reported\. The rules below say what can count besides a police report, like /,
      );
    // South Carolina: the statute's report requirement leads, after Tend's note on the program's anonymous route.
    expect(
      section("SC", "police")
        .slice(0, 2)
        .map((f) => [f.kind, f.text.slice(0, 40)]),
    ).toEqual([
      ["note", "Note: South Carolina law says an award n"],
      ["law", "The program asks that the crime be repor"],
    ]);
  });

  it("report tiles cite the rule behind every limit they state", () => {
    // Massachusetts: "time limits apply" comes from c. 258C, s. 2(b).
    expect(tile("MA", "report")?.cites).toContain("MA-REPORT-1");
    // Hawaii: the statute that sets the requirement leads, then the 72-hour definition.
    expect(tile("HI", "report")?.cites).toEqual(["HI-REPORT-1", "HI-REPORT-2"]);
    // Delaware and Montana: the 72-hour windows in their quotes reach the tile.
    expect(tile("DE", "report")?.small).toBe("not the only record that counts, but time limits apply");
    expect(tile("MT", "report")?.small).toBe(
      "the program asks for one within 72 hours, or later if the office finds good cause or it was a sexual offense against a minor",
    );
    // North Dakota: the child rule's own exception joins the window.
    expect(tile("ND", "report")?.small).toMatch(
      /, or, for abuse of a child, within 3 years after the child becomes an adult$/,
    );
  });

  it("deadline tiles cite the rules behind 'with exceptions', and a rule the headline already states is not repeated", () => {
    expect(tile("AK", "deadline")?.cites).toEqual(["AK-DEADLINE-1", "AK-DEADLINE-2"]);
    // Maine: ME-DEAD-2 quotes the headline rule's own sentence for the 60 days from discovery.
    const me = section("ME", "deadline");
    expect(me[0].cites).toEqual(["ME-DEAD-1", "ME-DEAD-2"]);
    expect(me.map((f) => f.cites[0])).toEqual(["ME-DEAD-1", "ME-DEAD-3"]);
  });

  it("cost rows say what each rule covers when one name would say more or less", () => {
    const costs = (st: string) => section(st, "costs");
    // Texas: two scopes, so the row keeps its name and shows both (56B.106(c) and (c-1)).
    const moving = costs("TX").find((f) => f.label === "Moving")!;
    expect(moving.details!.slice(0, 2).map((d) => d.cite)).toEqual(["TX-RELO-1", "TX-RELO-4"]);
    // West Virginia and Wisconsin: a limit on the row is about something else than the one scope.
    expect(
      costs("WV")
        .find((f) => f.label === "Travel")
        ?.details?.map((d) => d.cite),
    ).toEqual(["WV-COV-3", "WV-CAP-3"]);
    expect(
      costs("WI")
        .find((f) => f.label === "Replacing belongings")
        ?.details?.map((d) => d.cite),
    ).toEqual(["WI-COV-5", "WI-CAP-2", "WI-CAP-4"]);
    // Alabama: the only prescription rule is HIV prevention medicine, and the row says so.
    expect(costs("AL").find((f) => f.cites[0] === "AL-COV-HIV")?.label).toBe(
      "A 28-day course of HIV prevention medicine, if you are at risk of HIV exposure",
    );
    // Maine: a covered cost set aside as someone else's shows in its own words.
    expect(costs("ME").find((f) => f.key === "covered-aside-ME-TRANS-1")?.verbatimSummary).toBe(true);
  });

  it("an exam rule's place limit and the statute behind the tile come first (Vermont, South Carolina, Louisiana)", () => {
    expect(tile("VT", "exam")).toMatchObject({
      big: "Forensic exam",
      small: "you should not have to pay for it if the crime was in Vermont",
    });
    expect(tile("VT", "exam")?.cites[0]).toBe("VT-EXAM-5");
    expect(tile("SC", "exam")?.cites[0]).toBe("SC-EXAM-3");
    expect(tile("LA", "exam")?.cites[0]).toBe("LA-EXAM-5");
  });

  it("page notes say where a program's own papers disagree with the law the page follows", () => {
    for (const [st, id] of [
      ["MD", "police"],
      ["MD", "deadline"],
      ["MD", "costs"],
      ["MD", "urgent"],
      ["NV", "police"],
      ["VA", "police"],
      ["SC", "police"],
      ["WV", "privacy"],
      ["LA", "deadline"],
    ])
      expect(section(st, id)[0], `${st} ${id}`).toMatchObject({ key: `${id}-note`, kind: "note", cites: [] });
  });
});

// The topic verifiers' third round: limits that sit in the cited sources and the cards they change.
describe("conditions the third review found missing", () => {
  const get = (st: string) => built.get(st)!.summary;
  const section = (st: string, id: string) => get(st).sections.find((s) => s.id === id)!.facts;
  const tile = (st: string, id: string) => get(st).keyFacts.find((k) => k.id === id);

  it("an exam rule's place limit reaches the lead, the tile and the card (Delaware, Massachusetts, Maine, Virginia)", () => {
    // 11 Del. C. 9021: the chapter with the free exam rule applies to crimes committed in Delaware.
    expect(section("DE", "exam")[0]).toMatchObject({
      text: "You should not have to pay for a sexual assault forensic exam if the crime was in Delaware.",
      cites: ["DE-EXAM-4", "DE-EXAM-1", "DE-EXAM-2"],
    });
    expect(tile("MA", "exam")).toMatchObject({
      big: "Forensic exam",
      small: "you should not have to pay for it if the crime was in Massachusetts",
    });
    // One rule carries both of Maine's limits, so the headline stays.
    expect(section("ME", "exam")[0].text).toBe(
      "You should not have to pay for a sexual assault forensic exam if an evidence kit is used for a crime in Maine.",
    );
    // Virginia: evidence collection, within 120 hours, for a crime in Virginia.
    expect(tile("VA", "exam")?.small).toBe(
      "you should not have to pay for evidence collection if done within 120 hours of a crime in Virginia",
    );
    // The exam clause no longer fits these cards, so the deadline takes its place.
    for (const st of ["MA", "VA"]) expect(get(st).share.clauses.map((c) => c.id), st).toEqual(["total", "deadline"]);
  });

  it("where no record an anonymous adult can get replaces the report, the card says a report is asked for (Delaware)", () => {
    // 9010(a)(5): protective services, Family Court, a protection order, cooperation with police, or the
    // Agency's discretion. The tile still says other records count.
    expect(get("DE").share.text).toBe(
      "If you're Jane Doe in Delaware: you can ask for up to $25,000, or more in some cases, and the program asks for a police report.",
    );
    expect(get("DE").share.clauses[1].cites).toEqual(["DE-REPORT-1", "DE-REPORT-2"]);
    expect(tile("DE", "report")?.small).toBe("not the only record that counts, but time limits apply");
  });

  it("where the program may waive the report after an exam, the card says the exam can sometimes count (Iowa)", () => {
    expect(get("IA").share.text).toBe(
      "If you're Jane Doe in Iowa: you can ask to be paid back for costs like medical care and travel, and a forensic exam can sometimes count instead of a police report.",
    );
    expect(get("IA").share.clauses[1]).toMatchObject({ id: "report", text: EXAM_SOMETIMES });
    expect(get("IA").share.clauses[1].cites[0]).toBe("IA-REPORT-2");
    // The tile and the lead still follow the statute.
    expect(tile("IA", "report")?.big).toBe("Police report");
  });

  it("a report tile leads with the rule that sets the requirement and carries its exceptions (Hawaii, Texas)", () => {
    expect(tile("HI", "report")).toMatchObject({
      small: "the program asks for one within 72 hours, or later only if you show good cause, unless an arrest was made",
      cites: ["HI-REPORT-1", "HI-REPORT-2"],
    });
    // 56B.053(c): the report rule does not apply to a child; the card keeps 56B.053(a) first.
    expect(tile("TX", "report")).toMatchObject({
      small: "the program asks for one, unless the victim is a child",
      cites: ["TX-REPORT-1", "TX-REPORT-3"],
    });
    expect(get("TX").share.clauses[1].cites[0]).toBe("TX-REPORT-1");
  });

  it("a total says 'or more' only when the survivor could get more (North Carolina, Nebraska)", () => {
    // 15B-11(g): only funeral costs, paid after a death, sit on top of the $45,000.
    expect(section("NC", "costs").slice(0, 2).map((f) => f.text)).toEqual([
      "The most the program can pay in total is $45,000.",
      "Payments for funeral costs do not count toward this limit.",
    ]);
    expect(tile("NC", "total")?.small).toBe("the most you can ask for in total");
    expect(get("NC").share.text).toBe(
      "If you're Jane Doe in North Carolina: you can ask for up to $45,000, the program asks for a police report, and you should not have to pay for a forensic exam.",
    );
    // 81-1823 opens "Except as provided in section 81-1813".
    expect(section("NE", "costs")[0]).toMatchObject({
      text: "The most the program can pay in total is $25,000, or more in some cases.",
      cites: ["NE-CAP-1", "NE-CAP-6"],
    });
  });

  it("a limit with no amount shows under its cost and never changes the row's name (Texas, Florida, North Dakota)", () => {
    const row = (st: string, label: string) => section(st, "costs").find((f) => f.label === label);
    expect(
      row("TX", "Trips over 20 miles one way to medical or mental health care, court, or a victim's funeral")?.details?.map(
        (d) => d.cite,
      ),
    ).toEqual(["TX-TRAVEL-2"]);
    expect(row("FL", "Medical care")?.details?.map((d) => d.cite)).toEqual(["FL-CAP-2", "FL-CAP-9"]);
    expect(row("ND", "Travel")?.details?.map((d) => d.cite)).toEqual(["ND-CAP-TRAVEL", "ND-CAP-TRAVEL-MIN"]);
  });

  it("cooperation rules show in the police section in their own words and change no tile or card", () => {
    for (const [st, id] of [
      ["CO", "CO-COOP-1"],
      ["MO", "MO-REP-3"],
      ["RI", "RI-REPORT-6"],
      ["NE", "NE-REP-3"],
      ["NH", "NH-REP-3"],
    ]) {
      expect(section(st, "police").find((f) => f.cites[0] === id)?.verbatimSummary, id).toBe(true);
      expect(tile(st, "report")?.cites, id).not.toContain(id);
      expect(get(st).share.clauses.flatMap((c) => c.cites), id).not.toContain(id);
    }
  });
});

// A small made-up jurisdiction for the edges the corpus does not show cleanly.
function rule(id: string, category: string, params: Record<string, unknown>, summary = `${id} summary`): Rule {
  return {
    id,
    category: category as Rule["category"],
    params,
    summary,
    quote: `${id} quote`,
    source_id: "ZZ-S1",
    pinpoint: id,
  };
}

// extra: jurisdiction fields the type does not list yet, such as page_notes.
function zz(rules: Rule[], ir: IrSummary | null = null, extra: Record<string, unknown> = {}) {
  const law: Jurisdiction = {
    jurisdiction: "ZZ",
    name: "Zedland",
    program: {
      program_name: "Zedland Victim Fund",
      agency: "Zedland Board",
      website: "https://example.org",
      phone: null,
    },
    sources: [
      {
        id: "ZZ-S1",
        title: "Zedland Act",
        url: "https://example.org/act",
        kind: "statute",
        retrieved_at: "2026-10-03T00:00:00Z",
        sha256: "0".repeat(64),
      },
    ],
    rules,
    coverage: { found: [], not_found: [] },
    confidence: "high",
    ...extra,
  };
  return buildStateSummary(law, ir);
}

describe("summary rules on a made-up jurisdiction", () => {
  it("says no police report is required only when every report rule says so", () => {
    const none = zz([rule("ZZ-R1", "reporting_requirement", { required: false, alternatives: ["medical_provider"] })]);
    expect(none.keyFacts.find((k) => k.id === "report")).toMatchObject({
      big: "Police report",
      small: "not the only record that counts",
    });
    expect(none.sections.find((s) => s.id === "police")!.facts[0].text).toBe(
      "A police report is not the only way to qualify. The rules below say which other records can count and when, like medical records.",
    );
    // With no alternative named anywhere, "not required" is what the rule says.
    const bare = zz([rule("ZZ-R1", "reporting_requirement", { required: false })]);
    expect(bare.keyFacts.find((k) => k.id === "report")?.small).toBe("not required to apply");
    expect(bare.sections.find((s) => s.id === "police")!.facts[0].text).toBe("A police report is not required.");
    const mixed = zz([
      rule("ZZ-R1", "reporting_requirement", { required: false, alternatives: ["forensic_exam"] }),
      rule("ZZ-R2", "reporting_requirement", { required: true, within_hours: 72 }),
    ]);
    expect(mixed.keyFacts.find((k) => k.id === "report")).toMatchObject({
      big: "Police report",
      small: "the program asks for one within 72 hours",
      cites: ["ZZ-R2"],
    });
    // The required rule names no other record, so the card says a report is asked for, and the lead
    // follows the required rule. The waiver shows below in its own words (South Carolina's anonymous route
    // in program papers, with a page note where they disagree with the statute).
    expect(mixed.share.clauses.find((c) => c.id === "report")?.text).toBe(ASKS_FOR_REPORT);
    expect(mixed.sections.find((s) => s.id === "police")!.facts[0].text).toBe(
      "The program asks that the crime be reported to police.",
    );
  });

  it("carries a report rule's exception after its window and cites the rule that holds it", () => {
    const s = zz([
      rule("ZZ-R1", "reporting_requirement", { required: true, within_days: 5, exception: "counted from discovery" }),
      rule("ZZ-R2", "reporting_requirement", { required: true, exception: "or later for good cause" }),
      rule("ZZ-R3", "reporting_requirement", { required: true }),
    ]);
    // The timed rule and the rule holding an exception first, then the other rule that sets the requirement.
    expect(s.keyFacts.find((k) => k.id === "report")).toMatchObject({
      small: "the program asks for one within 5 days, counted from discovery, or later for good cause",
      cites: ["ZZ-R1", "ZZ-R2", "ZZ-R3"],
    });
    // The rule that sets the requirement leads even when a later rule holds the window (Hawaii).
    const later = zz([
      rule("ZZ-R1", "reporting_requirement", { required: true, exception: "unless an arrest was made" }),
      rule("ZZ-R2", "reporting_requirement", { required: true, within_hours: 72 }),
    ]);
    expect(later.keyFacts.find((k) => k.id === "report")).toMatchObject({
      small: "the program asks for one within 72 hours, unless an arrest was made",
      cites: ["ZZ-R1", "ZZ-R2"],
    });
    expect(later.share.clauses.find((c) => c.id === "report")?.cites[0]).toBe("ZZ-R1");
  });

  it("asks for a report on the card where the other records are not hers to get, and softens it where an exam may count", () => {
    // report_gate: the rule names other records, but none an anonymous adult can get on her own.
    const gated = zz([
      rule("ZZ-T1", "total_cap", { amount_cents: 1500000 }),
      rule("ZZ-R1", "reporting_requirement", {
        required: true,
        within_hours: 72,
        alternatives: ["protective_order"],
        report_gate: true,
      }),
      rule("ZZ-R2", "reporting_requirement", { required: true }),
    ]);
    expect(gated.keyFacts.find((k) => k.id === "report")?.small).toBe(
      "not the only record that counts, but time limits apply",
    );
    expect(gated.share.clauses.find((c) => c.id === "report")).toEqual({
      id: "report",
      text: ASKS_FOR_REPORT,
      cites: ["ZZ-R1", "ZZ-R2"],
    });
    // waiver_records: every award needs a report, but the program may waive it after a forensic exam.
    const waived = zz([
      rule("ZZ-T1", "total_cap", { amount_cents: 1500000 }),
      rule("ZZ-R1", "reporting_requirement", { required: true, within_hours: 72 }),
      rule("ZZ-R2", "reporting_requirement", { required: true, waiver_records: ["forensic_exam", "advocate"] }),
    ]);
    expect(waived.keyFacts.find((k) => k.id === "report")?.small).toBe("the program asks for one within 72 hours");
    expect(waived.share.clauses.find((c) => c.id === "report")).toEqual({
      id: "report",
      text: EXAM_SOMETIMES,
      cites: ["ZZ-R2", "ZZ-R1"],
    });
    expect(waived.share.text).toBe(
      "If you're Jane Doe in Zedland: you can ask for up to $15,000, and a forensic exam can sometimes count instead of a police report.",
    );
  });

  it("says an exam counts only with its own limit, and not at all when two rules set different ones", () => {
    const one = zz([
      rule("ZZ-R1", "reporting_requirement", {
        required: true,
        alternatives: ["forensic_exam"],
        exam_condition: "done within 5 days of the crime",
      }),
    ]);
    expect(one.keyFacts.find((k) => k.id === "report")).toMatchObject({
      big: "Exam can count",
      small: "in place of a police report, if it was done within 5 days of the crime",
    });
    expect(one.share.clauses.find((c) => c.id === "report")?.text).toBe(
      "a forensic exam done within 5 days of the crime can count instead of a police report",
    );
    const two = zz([
      rule("ZZ-R1", "reporting_requirement", {
        required: true,
        alternatives: ["forensic_exam"],
        exam_condition: "done within 5 days of the crime",
      }),
      rule("ZZ-R2", "reporting_requirement", {
        required: true,
        alternatives: ["forensic_exam"],
        exam_condition: "done within 10 days of the crime",
      }),
    ]);
    expect(two.keyFacts.find((k) => k.id === "report")).toMatchObject({
      big: "Police report",
      small: "not the only record that counts",
    });
    expect(two.share.clauses.some((c) => c.id === "report")).toBe(false);
    expect(templatedText(two).join(" ")).not.toMatch(/exam can count/i);
  });

  it("shows waivers for the exam alone and narrower report rules only in their own words", () => {
    const s = zz([
      rule("ZZ-R1", "reporting_requirement", { required: true, within_hours: 72 }),
      rule("ZZ-R2", "reporting_requirement", { required: false, expense: "forensic_exam" }),
      rule("ZZ-R3", "reporting_requirement", {
        required: false,
        alternatives: ["advocate"],
        scope: "counseling claims",
      }),
    ]);
    const police = s.sections.find((x) => x.id === "police")!.facts;
    expect(police[0]).toMatchObject({
      text: "The program asks that the crime be reported to police.",
      cites: ["ZZ-R1"],
    });
    expect(police.slice(1).map((f) => [f.cites[0], f.verbatimSummary])).toEqual([
      ["ZZ-R1", true],
      ["ZZ-R2", true],
      ["ZZ-R3", true],
    ]);
    expect(s.share.clauses.find((c) => c.id === "report")?.cites).toEqual(["ZZ-R1"]);
  });

  it("leaves out caps the normalizer set aside, but keeps lower duplicates as lower limits", () => {
    const rules = [
      rule("ZZ-C1", "covered_expense", { expense: "counseling" }),
      rule("ZZ-K1", "expense_cap", { expense: "counseling", amount_cents: 10000, per: "session" }),
      rule("ZZ-K2", "expense_cap", { expense: "counseling", amount_cents: 6000, per: "session" }),
      rule("ZZ-K3", "expense_cap", {
        expense: "counseling",
        amount_cents: 99900,
        per: "session",
        applies_to: "siblings",
      }),
    ];
    const ir: IrSummary = {
      ir_version: 2,
      jurisdiction: "ZZ",
      source_sha256: null,
      ir_sha256: "x",
      fresh: true,
      rules: [
        { id: "ZZ-C1", kind: "covered", expense: "counseling" },
        { id: "ZZ-K1", kind: "expense_cap", expense: "counseling", cap_cents: 10000, per: "unit", unit: "session" },
      ],
      skipped: [
        { id: "ZZ-K2", reason: "less generous duplicate of ZZ-K1" },
        { id: "ZZ-K3", reason: 'applies_to "siblings"' },
      ],
    };
    const row = zz(rules, ir)
      .sections.flatMap((s) => s.facts)
      .find((f) => f.label === "Counseling")!;
    expect(row.details!.map((d) => d.text)).toEqual(["ZZ-K1 summary.", "ZZ-K2 summary."]);
    expect(row.cites).toEqual(["ZZ-C1", "ZZ-K1", "ZZ-K2"]);
    // Without an IR, applies_to alone sets a rule aside.
    const noIr = zz(rules)
      .sections.flatMap((s) => s.facts)
      .find((f) => f.label === "Counseling")!;
    expect(noIr.cites).not.toContain("ZZ-K3");
  });

  it("drops a covered cost the engine excludes as a whole category", () => {
    const rules = [
      rule("ZZ-C1", "covered_expense", { expense: "legal" }),
      rule("ZZ-X1", "excluded_expense", { expense: "legal" }),
    ];
    const s = zz(rules);
    expect(s.sections.flatMap((x) => x.facts).some((f) => f.label === "Legal help")).toBe(false);
    expect(s.sections.find((x) => x.id === "not-covered")!.facts.map((f) => f.cites[0])).toEqual(["ZZ-X1"]);
  });

  it("joins words and names a cost from its limits alone", () => {
    expect(joinWords(["a"])).toBe("a");
    expect(joinWords(["a", "b"])).toBe("a and b");
    expect(joinWords(["a", "b", "c"], "or")).toBe("a, b, or c");
    const weekly = zz([
      rule("ZZ-W1", "expense_cap", { expense: "lost_wages", amount_cents: 60000, per: "week" }),
      rule("ZZ-W2", "expense_cap", { expense: "lost_wages", amount_cents: 3000000, per: "claim" }),
      rule("ZZ-W3", "expense_cap", { expense: "lost_wages", per: "week" }),
    ]);
    const row = weekly.sections.flatMap((s) => s.facts).find((f) => f.label === "Lost pay")!;
    // A limit with no amount (a week count) shows under its cost, after the limits the engine applies.
    expect(row.details!.map((d) => d.cite)).toEqual(["ZZ-W1", "ZZ-W2", "ZZ-W3"]);
    // On its own it never makes a cost payable.
    const countOnly = zz([rule("ZZ-W3", "expense_cap", { expense: "lost_wages", per: "week", count_limit: 26 })]);
    expect(countOnly.sections.flatMap((s) => s.facts).some((f) => f.label === "Lost pay")).toBe(false);
  });

  it("names a cost row from its scope, keeps the cost name for several, and never puts a scoped row on the card", () => {
    const one = zz([
      rule("ZZ-C1", "covered_expense", { expense: "medical" }),
      rule("ZZ-C2", "covered_expense", { expense: "transportation", scope: "mileage to medical care" }),
      rule("ZZ-C3", "covered_expense", { expense: "counseling" }),
    ]);
    const facts = one.sections.flatMap((s) => s.facts);
    expect(facts.find((f) => f.cites[0] === "ZZ-C2")?.label).toBe("Mileage to medical care");
    expect(one.share.clauses[0]).toMatchObject({
      id: "covered",
      text: "you can ask to be paid back for costs like medical care and counseling",
      cites: ["ZZ-C1", "ZZ-C3"],
    });
    const two = zz([
      rule("ZZ-C1", "covered_expense", { expense: "transportation", scope: "mileage to medical care" }),
      rule("ZZ-C2", "covered_expense", { expense: "transportation", scope: "trips to court" }),
    ]);
    const travel = two.sections.flatMap((s) => s.facts).find((f) => f.label === "Travel")!;
    expect(travel.details!.map((d) => d.cite)).toEqual(["ZZ-C1", "ZZ-C2"]);
    expect(two.share.clauses.some((c) => c.id === "covered")).toBe(false);
    // A general rule with a narrower one: the cost keeps its name, and the narrower rule's own words show.
    const mixed = zz([
      rule("ZZ-C1", "covered_expense", { expense: "counseling" }),
      rule("ZZ-C2", "covered_expense", { expense: "counseling", scope: "counseling from a licensed provider" }),
      rule("ZZ-K1", "expense_cap", { expense: "counseling", amount_cents: 10000, per: "session" }),
    ]);
    const counseling = mixed.sections.flatMap((s) => s.facts).find((f) => f.label === "Counseling")!;
    expect(counseling.details!.map((d) => d.cite)).toEqual(["ZZ-C2", "ZZ-K1"]);
  });

  it("names a row of limits from the one item they share, and keeps it off the card", () => {
    const s = zz([
      rule("ZZ-K1", "expense_cap", {
        expense: "property_replacement",
        amount_cents: 50000,
        per: "claim",
        item: "eyeglasses",
      }),
      rule("ZZ-C1", "covered_expense", { expense: "medical" }),
    ]);
    expect(s.sections.flatMap((x) => x.facts).find((f) => f.cites[0] === "ZZ-K1")?.label).toBe("Eyeglasses");
    expect(s.share.clauses[0].text).toBe("you can ask to be paid back for costs like medical care");
  });

  it("falls back to covered costs for the card when there is no total cap", () => {
    const s = zz([
      rule("ZZ-C1", "covered_expense", { expense: "medical" }),
      rule("ZZ-C2", "covered_expense", { expense: "counseling" }),
      rule("ZZ-E1", "exam_no_bill", { insurance_billing: "prohibited" }),
    ]);
    expect(s.share.text).toBe(
      "If you're Jane Doe in Zedland: you can ask to be paid back for costs like medical care and counseling, and you should not have to pay for a forensic exam.",
    );
    expect(s.sections.find((x) => x.id === "exam")!.facts.map((f) => f.text)).toEqual([
      "You should not have to pay for a sexual assault forensic exam.",
      "The provider should not bill your insurance for it either.",
    ]);
  });

  it("carries an exam rule's scope and condition into the line, the tile and the card", () => {
    const s = zz([
      rule("ZZ-T1", "total_cap", { amount_cents: 1500000 }),
      rule("ZZ-E1", "exam_no_bill", {
        insurance_billing: "prohibited",
        scope: "the evidence kit",
        condition: "if you are 16 or older",
      }),
      rule("ZZ-E2", "exam_no_bill", {}),
    ]);
    const exam = s.sections.find((x) => x.id === "exam")!.facts;
    expect(exam[0]).toMatchObject({
      text: "You should not have to pay for the evidence kit if you are 16 or older.",
      cites: ["ZZ-E1", "ZZ-E2"],
      details: [{ text: "ZZ-E1 summary.", cite: "ZZ-E1" }],
    });
    // The bar rule's own condition starts its insurance line.
    expect(exam[1]).toMatchObject({
      text: "If you are 16 or older, the provider should not bill your insurance for it either.",
      cites: ["ZZ-E1"],
    });
    expect(s.keyFacts.find((k) => k.id === "exam")).toMatchObject({
      big: "Forensic exam",
      small: "you should not have to pay for the evidence kit if you are 16 or older",
    });
    expect(s.share.clauses[1].text).toBe("you should not have to pay for the evidence kit if you are 16 or older");
  });

  it("cites a payment rule's condition first, and drops the headline when two rules disagree", () => {
    const paid = zz([
      rule("ZZ-E1", "exam_no_bill", {}),
      rule("ZZ-P1", "exam_payment", { payer: "the fund", condition: "if done within 5 days of the assault" }),
    ]);
    expect(paid.keyFacts.find((k) => k.id === "exam")).toMatchObject({
      small: "you should not have to pay for it if done within 5 days of the assault",
      cites: ["ZZ-P1", "ZZ-E1"],
    });
    const split = zz([
      rule("ZZ-E1", "exam_no_bill", { condition: "if you are 16 or older" }),
      rule("ZZ-E2", "exam_no_bill", { condition: "if done within 5 days of the assault" }),
    ]);
    expect(split.keyFacts.some((k) => k.id === "exam")).toBe(false);
    expect(split.share.clauses.some((c) => c.id === "exam")).toBe(false);
    expect(split.sections.find((x) => x.id === "exam")!.facts.every((f) => f.verbatimSummary)).toBe(true);
  });

  it("hedges a total with its exception or condition, and keeps payments outside it apart", () => {
    const more = zz([
      rule("ZZ-T1", "total_cap", { amount_cents: 2500000, exception: "or up to $50,000 for a catastrophic injury" }),
      rule("ZZ-P1", "exam_payment", { payer: "the fund", outside_total_cap: true }),
    ]);
    expect(
      more.sections
        .find((x) => x.id === "costs")!
        .facts.slice(0, 2)
        .map((f) => f.text),
    ).toEqual([
      "The most the program can pay in total is $25,000, or up to $50,000 for a catastrophic injury.",
      "Payments for the forensic exam do not count toward this limit.",
    ]);
    expect(more.keyFacts.find((k) => k.id === "total")?.small).toBe(
      "the most you can ask for in total, except in some cases",
    );
    expect(more.share.clauses[0].text).toBe("you can ask for up to $25,000, or more in some cases");
    const dated = zz([
      rule("ZZ-T1", "total_cap", { amount_cents: 3000000, condition: "for a crime on or after July 1, 2025" }),
      rule("ZZ-C1", "covered_expense", { expense: "medical" }),
    ]);
    expect(dated.keyFacts.find((k) => k.id === "total")?.small).toBe(
      "the most you can ask for in total, for a crime on or after July 1, 2025",
    );
    expect(dated.share.clauses[0].id).toBe("covered");
  });

  it("hedges a total with another cap's tier or added award, but never with someone else's", () => {
    const added = zz([
      rule("ZZ-T1", "total_cap", { amount_cents: 1500000 }),
      rule("ZZ-T2", "total_cap", { exception: "or up to $10,000 more for a catastrophic injury" }),
      rule("ZZ-T3", "total_cap", {}),
    ]);
    const costs = added.sections.find((x) => x.id === "costs")!.facts;
    expect(costs[0]).toMatchObject({
      text: "The most the program can pay in total is $15,000, or up to $10,000 more for a catastrophic injury.",
      cites: ["ZZ-T1", "ZZ-T2"],
    });
    // The added award is cited on the line, not repeated; a cap note with no exception shows in its own words.
    expect(costs.map((f) => f.key)).toEqual(["total", "total-over-ZZ-T3"]);
    expect(added.share.clauses[0].text).toBe("you can ask for up to $15,000, or more in some cases");
    const family = zz([
      rule("ZZ-T1", "total_cap", { amount_cents: 1500000 }),
      rule("ZZ-T2", "total_cap", {
        amount_cents: 2500000,
        exception: "or more for a family",
        applies_to: "family members",
      }),
    ]);
    expect(family.share.clauses[0].text).toBe("you can ask for up to $15,000");
  });

  it("keeps the cost name when a limit on a one-scope row is about something else, and shows set-aside costs", () => {
    const s = zz([
      rule("ZZ-C1", "covered_expense", { expense: "transportation", scope: "travel to medical care" }),
      rule("ZZ-K1", "expense_cap", {
        expense: "transportation",
        amount_cents: 50000,
        per: "claim",
        scope: "court travel",
      }),
      rule("ZZ-C2", "covered_expense", { expense: "counseling", applies_to: "a parent of a child victim" }),
    ]);
    const costs = s.sections.find((x) => x.id === "costs")!.facts;
    expect(costs.find((f) => f.label === "Travel")?.details?.map((d) => d.cite)).toEqual(["ZZ-C1", "ZZ-K1"]);
    expect(costs.at(-1)).toMatchObject({ key: "covered-aside-ZZ-C2", verbatimSummary: true });
    expect(s.share.clauses.some((c) => c.id === "covered")).toBe(false);
  });

  it("carries a deadline's condition and extension, and never leads with a deadline counted from discovery", () => {
    const s = zz([
      rule("ZZ-D1", "filing_deadline", { years: 2, from: "discovery" }),
      rule("ZZ-D2", "filing_deadline", {
        years: 3,
        from: "crime",
        condition: "for a crime on or after July 1, 2025",
        extension: "or later if the board finds good cause",
      }),
      rule("ZZ-D3", "filing_deadline", { years: 1, from: "trip" }),
    ]);
    const deadline = s.sections.find((x) => x.id === "deadline")!.facts;
    expect(deadline.map((f) => f.cites[0])).toEqual(["ZZ-D2", "ZZ-D1", "ZZ-D3"]);
    expect(deadline[0].text).toBe(
      "Apply within 3 years of the date it happened, for a crime on or after July 1, 2025, or later if the board finds good cause. The rules below say more.",
    );
    // The headline rule first, then the rule that makes "with exceptions" true (not the trip rule).
    expect(s.keyFacts.find((k) => k.id === "deadline")).toMatchObject({
      big: "3 years",
      small: "to apply, from the date it happened, for a crime on or after July 1, 2025, with exceptions",
      cites: ["ZZ-D2", "ZZ-D1"],
    });
    // An extension written as a sentence follows the headline.
    const sentence = zz([
      rule("ZZ-D1", "filing_deadline", { years: 1, from: "crime", extension: "You can apply later with good cause." }),
    ]);
    expect(sentence.sections.find((x) => x.id === "deadline")!.facts[0].text).toBe(
      "Apply within 1 year of the date it happened. You can apply later with good cause.",
    );
    const onlyDiscovery = zz([rule("ZZ-D1", "filing_deadline", { years: 2, from: "discovery" })]);
    expect(onlyDiscovery.keyFacts.some((k) => k.id === "deadline")).toBe(false);
    // A deadline for one travel request is not an exception to the application's deadline.
    const trip = zz([
      rule("ZZ-D3", "filing_deadline", { years: 1, from: "trip" }),
      rule("ZZ-D1", "filing_deadline", { years: 2, from: "crime" }),
    ]);
    expect(trip.sections.find((x) => x.id === "deadline")!.facts.map((f) => [f.cites[0], f.text])).toEqual([
      ["ZZ-D1", "Apply within 2 years of the date it happened. The rules below cover other cases."],
      ["ZZ-D3", "ZZ-D3 summary."],
    ]);
    expect(trip.keyFacts.find((k) => k.id === "deadline")?.small).toBe("to apply, from the date it happened");
  });

  it("puts a page note first in its section, as Tend's note with no citation", () => {
    const s = zz([rule("ZZ-R1", "reporting_requirement", { required: true })], null, {
      page_notes: { police: "Note: The program's form still asks for a police report." },
    });
    expect(s.sections.find((x) => x.id === "police")!.facts[0]).toEqual({
      key: "police-note",
      text: "Note: The program's form still asks for a police report.",
      cites: [],
      kind: "note",
    });
  });

  it("titles the privacy section by what its rules cover, and says what is missing", () => {
    const acp = zz([rule("ZZ-A1", "address_confidentiality", {})]);
    const privacy = acp.sections.find((x) => x.id === "privacy")!;
    expect(privacy.title).toBe("Keeping your address private");
    expect(privacy.facts.at(-1)).toMatchObject({
      kind: "note",
      text: "Tend has not verified a law that keeps compensation records private in Zedland.",
    });
    const records = zz([rule("ZZ-P1", "record_confidentiality", {})]).sections.find((x) => x.id === "privacy")!;
    expect(records.title).toBe("Keeping your claim records private");
    expect(records.facts.at(-1)?.text).toBe("Tend has not verified an address confidentiality program for Zedland.");
  });

  it("says who may use a filing route, after the others, and leaves out a mail line with no address", () => {
    const s = zz([
      rule("ZZ-F1", "submission", { method: "online", target: "WebFile", condition: "for trained advocates" }),
      rule("ZZ-F2", "submission", { method: "mail", target: "the board's office" }),
      rule("ZZ-F3", "submission", { method: "fax", target: "555-0100" }),
    ]);
    expect(s.sections.find((x) => x.id === "apply")!.facts.map((f) => [f.label, f.text])).toEqual([
      ["Fax", "555-0100"],
      ["Online", "WebFile (for trained advocates)"],
    ]);
  });

  it("never turns a no-bill rule the normalizer set aside into the exam headline", () => {
    const rules = [
      rule("ZZ-T1", "total_cap", { amount_cents: 1500000 }),
      rule("ZZ-D1", "filing_deadline", { years: 1, from: "crime" }),
      rule("ZZ-E1", "exam_no_bill", { insurance_billing: "consent_required", applies_to: "reported exams" }),
    ];
    const ir: IrSummary = {
      ir_version: 2,
      jurisdiction: "ZZ",
      source_sha256: null,
      ir_sha256: "x",
      fresh: true,
      rules: [
        { id: "ZZ-T1", kind: "total_cap", cap_cents: 1500000 },
        { id: "ZZ-D1", kind: "deadline" },
      ],
      skipped: [{ id: "ZZ-E1", reason: 'applies_to "reported exams"' }],
    };
    for (const s of [zz(rules, ir), zz(rules)]) {
      expect(s.keyFacts.some((k) => k.id === "exam")).toBe(false);
      expect(s.share.text).toBe(
        "If you're Jane Doe in Zedland: you can ask for up to $15,000, and you have 1 year to apply.",
      );
      expect(s.sections.find((x) => x.id === "exam")!.facts).toMatchObject([
        { text: "ZZ-E1 summary.", cites: ["ZZ-E1"], verbatimSummary: true },
      ]);
    }
  });

  it("Wyoming: the exam no-bill policy covers only reported exams, so no page or card says 'never'", () => {
    const { summary } = built.get("WY")!;
    expect(summary.share.text).not.toMatch(/forensic exam/);
    expect(summary.keyFacts.map((k) => k.id)).not.toContain("exam");
    const exam = summary.sections.find((x) => x.id === "exam")!.facts;
    expect(exam.map((f) => f.text)).not.toContain("You should not have to pay for a sexual assault forensic exam.");
    expect(exam[0].cites).toEqual(["WY-EXAM-2"]);
  });
});

// Flesch-Kincaid grade with a rough syllable count. The quotes and the researchers' summaries are
// left out; this holds Tend's own templated sentences to the grade 6 to 8 goal in docs/UX.md.
function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 3) return 1;
  const groups = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "")
    .replace(/^y/, "")
    .match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

function grade(text: string): number {
  const sentences = text.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim()).length || 1;
  const words = text.split(/\s+/).filter(Boolean);
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  return 0.39 * (words.length / sentences) + 11.8 * (syl / words.length) - 15.59;
}

describe("reading level of Tend's own sentences", () => {
  const templated = [...built.values()].flatMap(({ summary }) =>
    summary.sections
      .filter((s) => s.id !== "apply")
      .flatMap((s) => s.facts)
      .filter((f) => f.kind === "law" && !f.verbatimSummary && f.text)
      .map((f) => f.text),
  );

  it("keeps each templated sentence at grade 9 or below, and the average under grade 6", () => {
    expect(templated.length).toBeGreaterThan(200);
    for (const t of templated) expect(grade(t), t).toBeLessThanOrEqual(9);
    const mean = templated.reduce((n, t) => n + grade(t), 0) / templated.length;
    expect(mean).toBeLessThanOrEqual(6);
  });

  it("keeps the one-sentence share line short", () => {
    for (const { summary } of built.values()) {
      expect(summary.share.text.split(/\s+/).length, summary.share.text).toBeLessThanOrEqual(32);
      expect(grade(summary.share.text), summary.share.text).toBeLessThanOrEqual(14);
    }
  });
});
