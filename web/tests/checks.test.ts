// Copy for the claim checks and engine errors, for outputs the engines can produce.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deadlineCheck, deadlineText, minimumText, reportingText } from "@/components/claim/Checks";
import { CATEGORY_LABEL, categoryLabelAboutThem } from "@/lib/categories";
import { engineErrorText } from "@/lib/engine/wasm";
import { checkCopy, DEADLINE, deadlineCopy, MINIMUM_LOSS, REPORTING, reportingCopy, STATUS } from "@/lib/status";
import type { LawIr } from "@/lib/deadline";
import type { Jurisdiction } from "@/lib/types";
import type { LawIndex } from "@/lib/useLaw";

const web = path.resolve(import.meta.dirname, "..");
const index = (st: string): LawIndex => {
  const law = JSON.parse(readFileSync(path.join(web, "public/data/law", `${st}.json`), "utf8")) as Jurisdiction;
  const rules = new Map(law.rules.map((r) => [r.id, r]));
  return {
    law,
    sha256: null,
    rule: (id) => rules.get(id),
    source: () => undefined,
    byCategory: (c) => law.rules.filter((r) => r.category === c),
  };
};

describe("claim check copy", () => {
  it("does not credit the exam when the state has no reporting rule", () => {
    const text = reportingText({ status: "satisfied", rule_ids: [] }, index("MI"), "no");
    expect(text).toMatch(/no police report rule/);
    expect(text).not.toMatch(/forensic exam/);
    expect(reportingCopy({ status: "satisfied", rule_ids: [] }).label).toBe("No rule found");
    expect(reportingCopy({ status: "satisfied", rule_ids: ["MI-REPORT-1"] }).label).toBe("Satisfied");
  });

  it("says a months-based deadline could not be dated instead of saying none exists", () => {
    const hi = index("HI");
    const ids = hi.byCategory("filing_deadline").map((r) => r.id);
    expect(deadlineText({ status: "unknown", deadline_date: null, rule_ids: ids })).toMatch(/could not turn/);
    expect(deadlineText({ status: "unknown", deadline_date: null, rule_ids: [] })).toMatch(/no filing deadline/);
  });

  it("never shows a deadline that may count from discovery or the report as plainly late (SPEC v1.3)", () => {
    const late = (flags: string[]) => ({
      status: "late" as const,
      deadline_date: "2025-06-14",
      rule_ids: ["X-1"],
      flags,
    });
    const discovery = late(["deadline_from_discovery"]);
    expect(deadlineCopy(discovery)).toEqual({ label: "May have more time", tone: "neutral" });
    expect(deadlineText(discovery)).toMatch(
      /^The usual deadline was .*may count from when the crime was discovered.*The program decides\.$/,
    );
    expect(deadlineCopy(late(["deadline_from_report"])).label).toBe("May have more time");
    expect(deadlineText(late(["deadline_from_report"]))).toMatch(/counts from their report, so they may have longer/);
    // An ordinary deadline counted from the incident is still plainly late.
    for (const plain of [late([]), { status: "late" as const, deadline_date: "2025-06-14", rule_ids: ["X-1"] }]) {
      expect(deadlineCopy(plain)).toEqual({ label: "Past the deadline", tone: "warn" });
      expect(deadlineText(plain)).not.toMatch(/discovered|report/);
    }
    // On time, the note still says the date may be later.
    const ok = { ...discovery, status: "ok" as const, deadline_date: "2099-06-14" };
    expect(deadlineCopy(ok)).toEqual({ label: "On time", tone: "good" });
    expect(deadlineText(ok, "2026-10-04")).toMatch(/may count from when the crime was discovered/);
  });

  it("names the waiver the law allows when the minimum is not met", () => {
    const mi = index("MI");
    const text = minimumText({ status: "not_met", rule_ids: ["MI-MIN-1"] }, mi);
    expect(text).toMatch(/\$200\.00/);
    expect(text).toMatch(/criminal sexual conduct/);
    expect(minimumText({ status: "may_be_waived", rule_ids: ["MI-MIN-1"] }, mi)).toMatch(/can waive/);
  });

  // This copy is only for the read-only claim an advocate opens (app/share): "you" there is the
  // advocate, so every status speaks about the survivor instead of to them.
  it("speaks about the survivor, never to them, in every status", () => {
    const mi = index("MI");
    const texts = [
      reportingText({ status: "satisfied", rule_ids: ["MI-REPORT-1"] }, mi, "yes"),
      reportingText({ status: "satisfied", rule_ids: ["MI-REPORT-1"] }, mi, "no"),
      reportingText({ status: "satisfied", rule_ids: [] }, mi, "no"),
      reportingText({ status: "required", rule_ids: ["MI-REPORT-2"] }, mi, "no"),
      reportingText({ status: "not_required", rule_ids: ["MI-REPORT-2"] }, mi, "no"),
      reportingText({ status: "unknown", rule_ids: ["MI-REPORT-1"] }, mi, "unknown"),
      reportingText({ status: "unknown", rule_ids: ["MI-REPORT-2"] }, mi, "unknown"),
      ...(["met", "waived", "may_be_waived", "not_met", "unknown"] as const).map((status) =>
        minimumText({ status, rule_ids: ["MI-MIN-1"] }, mi),
      ),
      minimumText({ status: "met", rule_ids: [] }, mi),
      deadlineText({ status: "ok", deadline_date: "2031-06-14", rule_ids: ["X-1"], flags: ["deadline_from_report"] }),
      deadlineText({
        status: "late",
        deadline_date: "2025-06-14",
        rule_ids: ["X-1"],
        flags: ["deadline_from_discovery"],
      }),
      deadlineText({ status: "unknown", deadline_date: null, rule_ids: ["X-1"] }),
      ...[DEADLINE, MINIMUM_LOSS, REPORTING].flatMap((table) => Object.values(table).map((c) => c.label)),
      ...Object.values(STATUS).flatMap((c) => [c.label, c.explain, c.sheetTitle]),
      ...Object.keys(CATEGORY_LABEL).map(categoryLabelAboutThem),
    ];
    expect(texts.filter((t) => /\b(you|your|yours|yourself)\b/i.test(t))).toEqual([]);
    expect(reportingText({ status: "required", rule_ids: ["MI-REPORT-2"] }, mi, "no")).toBe(
      "This program asks for a police report. Reporting is still their choice.",
    );
  });

  it("has labels for the v1.1 statuses", () => {
    expect(checkCopy(MINIMUM_LOSS, "may_be_waived").label).toBe("May be waived");
    expect(checkCopy(REPORTING, "not_required").label).toBe("No police report needed");
  });

  it("reads engine errors in either shape", () => {
    expect(engineErrorText({ code: "bad_image", message: "unsupported format version 1.1" })).toBe(
      "bad_image: unsupported format version 1.1",
    );
    expect(engineErrorText("no items")).toBe("no items");
    expect(engineErrorText({ other: 1 })).toBe('{"other":1}');
  });
});

// The advocate's share view leads with the general deadline, as the cited summary PDF does
// (lib/deadline.ts), and says nothing the rules do not: no program "extends it for good cause".
describe("the advocate's deadline and report checks", () => {
  const ir = (st: string) => JSON.parse(readFileSync(path.join(web, "public/data/ir", `${st}.json`), "utf8")) as LawIr;
  const fl = index("FL");
  const engine = {
    status: "ok" as const,
    deadline_date: "2031-06-14",
    rule_ids: fl.byCategory("filing_deadline").map((r) => r.id),
  };
  const ctx = { law: fl.law, ir: ir("FL"), incident: "2026-06-14" };

  it("Florida: File by the general 3 years, with the 5 years good cause can give as a note", () => {
    const due = deadlineCheck(engine, "2026-10-04", ctx);
    expect(due.text).toMatch(
      /^File by June 13, 2029\. That is .* from today\. Some cases have until June 14, 2031\. The rule says when\.$/,
    );
    expect(due.ruleIds[0]).toBe("FL-DEADLINE-1");
    expect(due.copy).toEqual({ label: "On time", tone: "good" });
  });

  it("Florida, past the 3 years: never plainly late, and sends them to ask", () => {
    const due = deadlineCheck(engine, "2030-01-02", ctx);
    expect(due.text).toBe(
      "The usual deadline was June 13, 2029. Some cases have until June 14, 2031. Ask the program whether theirs is one.",
    );
    expect(due.copy).toEqual({ label: "May have more time", tone: "neutral" });
  });

  it("never says a program extends a deadline for good cause", () => {
    const late = { status: "late" as const, deadline_date: "2025-06-14", rule_ids: ["X-1"] };
    expect(deadlineText(late)).toBe(
      "The usual deadline was June 14, 2025. Ask the program whether a late claim can still be filed.",
    );
    for (const today of ["2026-10-04", "2030-01-02", "2032-01-01"]) {
      expect(deadlineCheck(engine, today, ctx).text).not.toMatch(/good cause|Many programs/);
    }
  });

  it("Connecticut: the exam may count for the report, within the rule's own limit", () => {
    const text = reportingText({ status: "satisfied", rule_ids: ["CT-REPORT-1"] }, index("CT"), "no");
    expect(text).toBe("Their forensic exam may count in place of a police report here. The rule says when.");
    expect(reportingText({ status: "satisfied", rule_ids: ["MI-REPORT-1"] }, index("MI"), "no")).toBe(
      "Their forensic exam counts in place of a police report here.",
    );
  });
});
