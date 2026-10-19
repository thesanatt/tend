// lib/cite.ts on the engine's own output for Rowan (fixtures/rowan-mi.output.json) and Michigan's
// verified rules: a cost's citation leads with the rule that covers it, then every limit the law
// sets on that kind of cost in the law's order, then the rest.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { altCapIds, citedRuleIds, severalLimits } from "@/lib/cite";
import type { EngineLine, EngineOutput, Jurisdiction } from "@/lib/types";

const web = path.resolve(import.meta.dirname, "..");
const output = JSON.parse(readFileSync(path.join(web, "fixtures/rowan-mi.output.json"), "utf8")) as EngineOutput;
const law = JSON.parse(readFileSync(path.join(web, "public/data/law/MI.json"), "utf8")) as Jurisdiction;
const byId = new Map(law.rules.map((r) => [r.id, r]));
const rule = (id: string) => byId.get(id);
const lineOf = (expense: string, status?: string) =>
  output.lines.find((l) => l.expense === expense && (!status || l.status === status))!;
const cite = (line: Pick<EngineLine, "rule_ids" | "alt_cap_rule_ids">) => citedRuleIds(line, rule, law.rules);

describe("a cost's citation", () => {
  it("cites a $12 ride to the rule that covers rides to care, then both trip-length limits", () => {
    const ride = lineOf("transportation");
    expect(ride.requested_cents).toBe(1200);
    // The engine's proof keeps the $5,000 limit for trips of 50 miles or more and names the $1,000
    // one for shorter trips only as an alternative.
    expect(ride.rule_ids).toEqual(["MI-CAP-8", "MI-COV-7"]);
    expect(ride.alt_cap_rule_ids).toEqual(["MI-CAP-7"]);
    expect(cite(ride)).toEqual(["MI-COV-7", "MI-CAP-7", "MI-CAP-8"]);
    expect(rule(cite(ride)[0])!.pinpoint).toBe("MCL 18.361(2)(e)");
    expect(cite(ride).map((id) => rule(id)!.pinpoint)).toEqual([
      "MCL 18.361(2)(e)",
      "MCL 18.361(2)(e)(i)",
      "MCL 18.361(2)(e)(ii)",
    ]);
    expect(severalLimits(ride)).toBe(true);
  });

  it("puts counseling's coverage first, then every provider rate, then insurance", () => {
    const session = lineOf("counseling", "eligible");
    expect(session.cap_rule_id).toBe("MI-CAP-3");
    expect(cite(session)).toEqual([
      "MI-COV-2",
      "MI-CAP-2",
      "MI-CAP-3",
      "MI-CAP-4",
      "MI-COLL-1",
      "MI-COLL-2",
      "MI-COLL-3",
    ]);
  });

  it("leads with the limit when it is the only rule that names the cost", () => {
    const sheets = lineOf("clothing_bedding");
    expect(cite(sheets)).toEqual(["MI-CAP-10"]);
    expect(rule("MI-CAP-10")!.quote).toContain("held as evidence of a crime");
    expect(severalLimits(sheets)).toBe(false);
  });

  it("leaves held and excluded lines in the engine's order", () => {
    expect(cite(lineOf("forensic_exam"))).toEqual(["MI-EXAM-1", "MI-EXAM-2", "MI-EXAM-3", "MI-EXAM-4", "MI-EXAM-5"]);
    expect(cite(lineOf("property_replacement"))).toEqual(["MI-EXCL-1"]);
  });

  it("cites every rule the engine gave, once", () => {
    for (const line of output.lines) {
      const ids = cite(line);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual([...new Set([...line.rule_ids, ...altCapIds(line)])].sort());
    }
  });

  it("reads a shared claim's alternatives with care", () => {
    const base = { rule_ids: ["MI-CAP-8", "MI-COV-7"] };
    expect(cite({ ...base, alt_cap_rule_ids: "MI-CAP-7" as unknown as string[] })).toEqual(["MI-COV-7", "MI-CAP-8"]);
    expect(cite({ ...base, alt_cap_rule_ids: [5, "MI-CAP-7"] as unknown as string[] })).toEqual([
      "MI-COV-7",
      "MI-CAP-7",
      "MI-CAP-8",
    ]);
    // An id this law does not have stays, after the rules it does.
    expect(cite({ rule_ids: ["ZZ-1", "MI-CAP-8", "MI-COV-7"] })).toEqual(["MI-COV-7", "MI-CAP-8", "ZZ-1"]);
  });
});
