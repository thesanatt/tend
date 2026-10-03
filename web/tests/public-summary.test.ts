// The public state summary may say only what the verified rules say, and must cite every line.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildStateSummary,
  citedIds,
  duration,
  joinWords,
  plainMarks,
  type StateSummary,
} from "@/components/public/summary";
import type { IrSummary } from "@/components/public/types";
import { formatCentsShort } from "@/lib/money";
import type { Jurisdiction, Rule } from "@/lib/types";

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

// Every amount a rule's params name, as the page prints it.
function amounts(rules: Rule[]): Set<string> {
  const out = new Set<string>();
  for (const r of rules) {
    for (const v of Object.values(r.params ?? {})) if (typeof v === "number") out.add(formatCentsShort(v));
  }
  out.add(formatCentsShort(0));
  return out;
}

const DOLLARS = /\$\d[\d,]*(?:\.\d\d)?/g;
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
          expect(f.text).toMatch(/^Tend has not verified/);
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

  it.each(states)("%s: share line has the Jane Doe form and one or two cited clauses", (st) => {
    const { summary } = built.get(st)!;
    expect(summary.share.text.startsWith(`If you're Jane Doe in ${summary.place}: `)).toBe(true);
    expect(summary.share.text.endsWith(".")).toBe(true);
    expect(summary.share.clauses.length).toBeGreaterThanOrEqual(1);
    expect(summary.share.clauses.length).toBeLessThanOrEqual(2);
    for (const c of summary.share.clauses) expect(c.cites.length).toBeGreaterThan(0);
  });

  it.each(states)("%s: no em dashes, en dashes, curly quotes, or bullets in generated text", (st) => {
    for (const text of allText(built.get(st)!.summary)) expect(TYPOGRAPHIC.test(text), text).toBe(false);
  });

  it.each(states)("%s: the share total is the smallest total cap the engine applies", (st) => {
    const { ir, summary } = built.get(st)!;
    const caps = ir.rules.filter((r) => r.kind === "total_cap").map((r) => r.cap_cents!);
    const total = summary.share.clauses.find((c) => c.id === "total");
    if (!caps.length) {
      expect(total).toBeUndefined();
      return;
    }
    expect(total?.text).toBe(`you can ask for up to ${formatCentsShort(Math.min(...caps))}`);
  });

  it.each(states)("%s: the exam clause appears only where a required report rule names the exam", (st) => {
    const { law, summary } = built.get(st)!;
    const report = summary.share.clauses.find((c) => c.id === "report");
    const strong = law.rules.some(
      (r) =>
        r.category === "reporting_requirement" &&
        r.params?.required === true &&
        ([] as string[])
          .concat((r.params?.alternatives as string[] | string | undefined) ?? [])
          .includes("forensic_exam"),
    );
    expect(Boolean(report)).toBe(strong);
  });

  it.each(states)("%s: the deadline sentence matches its rule", (st) => {
    const { law, summary } = built.get(st)!;
    const fact = summary.sections.flatMap((s) => s.facts).find((f) => f.key === "deadline");
    if (!fact) return;
    const rule = law.rules.find((r) => r.id === fact.cites[0])!;
    expect(fact.text).toBe(`Apply within ${duration(rule)!.text} of the date it happened.`);
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

  it("Texas lists its exam exception but the card does not claim it", () => {
    const { summary } = built.get("TX")!;
    expect(summary.share.clauses.map((c) => c.id)).toEqual(["total", "exam"]);
    expect(summary.keyFacts.find((k) => k.id === "report")?.big).toBe("Police report");
  });

  it("DC is named DC on the card", () => {
    expect(built.get("DC")!.summary.share.text).toMatch(/^If you're Jane Doe in DC: /);
  });

  it("Kentucky has no verified deadline, and the page says so as Tend's note", () => {
    const deadline = built.get("KY")!.summary.sections.find((s) => s.id === "deadline")!;
    expect(deadline.facts).toEqual([expect.objectContaining({ kind: "note", cites: [] })]);
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

function zz(rules: Rule[], ir: IrSummary | null = null) {
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
  };
  return buildStateSummary(law, ir);
}

describe("summary rules on a made-up jurisdiction", () => {
  it("says no police report is required only when every report rule says so", () => {
    const none = zz([rule("ZZ-R1", "reporting_requirement", { required: false, alternatives: ["medical_provider"] })]);
    expect(none.keyFacts.find((k) => k.id === "report")).toMatchObject({ big: "No police report" });
    expect(none.sections.find((s) => s.id === "police")!.facts[0].text).toBe(
      "A police report is not required. Other records can count, like medical or counseling records.",
    );
    const mixed = zz([
      rule("ZZ-R1", "reporting_requirement", { required: false, alternatives: ["forensic_exam"] }),
      rule("ZZ-R2", "reporting_requirement", { required: true, within_hours: 72 }),
    ]);
    expect(mixed.keyFacts.find((k) => k.id === "report")).toMatchObject({
      big: "Police report",
      small: "the program asks for one within 72 hours",
      cites: ["ZZ-R2"],
    });
    expect(mixed.share.clauses.some((c) => c.id === "report")).toBe(false);
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
    // A limit with no amount says nothing to show.
    expect(row.details!.map((d) => d.cite)).toEqual(["ZZ-W1", "ZZ-W2"]);
  });

  it("falls back to covered costs for the card when there is no total cap", () => {
    const s = zz([
      rule("ZZ-C1", "covered_expense", { expense: "medical" }),
      rule("ZZ-C2", "covered_expense", { expense: "counseling" }),
      rule("ZZ-E1", "exam_no_bill", { insurance_billing: "prohibited" }),
    ]);
    expect(s.share.text).toBe(
      "If you're Jane Doe in Zedland: you can ask to be paid back for costs like medical care and counseling, and you should never get a bill for a forensic exam.",
    );
    expect(s.sections.find((x) => x.id === "exam")!.facts.map((f) => f.text)).toEqual([
      "You should not get a bill for a sexual assault forensic exam.",
      "The provider should not bill your insurance for it either.",
    ]);
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
