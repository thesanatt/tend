// Copy for the claim checks and engine errors, for outputs the engines can produce.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deadlineText, minimumText, reportingText } from "@/components/claim/Checks";
import { engineErrorText } from "@/lib/engine/wasm";
import { checkCopy, deadlineCopy, MINIMUM_LOSS, REPORTING, reportingCopy } from "@/lib/status";
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
    expect(deadlineText(late(["deadline_from_report"]))).toMatch(/counts from your report/);
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
