// The order a cost's law is cited in, the same in Gather, the shared claim, and the packet. The
// engine lists the rules for a kind of cost in rule order, so a limit can come before the rule that
// covers the cost. Where the law sets several limits on one kind of cost, the engine counts with the
// highest and names the others only in alt_cap_rule_ids (docs/SPEC.md v1.1): Michigan pays trips of
// 50 miles or less each way up to $1,000, and trips of 50 miles or more to care not available closer
// up to $5,000. So a citation leads with what makes the cost count, then every limit in the law's own
// order, then the rest as the engine gave them, and a $12 ride is never cited to the 50-mile rule
// alone. The public state pages order them the same way (components/public/summary.ts).
import type { EngineLine, Rule } from "./types";

type Lookup = (id: string) => Rule | undefined;

// A shared claim comes from a link, so this field is read with care.
export function altCapIds(line: Pick<EngineLine, "alt_cap_rule_ids">): string[] {
  const ids: unknown = line.alt_cap_rule_ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

export function citedRuleIds(
  line: Pick<EngineLine, "rule_ids" | "alt_cap_rule_ids">,
  rule: Lookup,
  lawRules: readonly Rule[] = [],
): string[] {
  const ids = [...new Set([...line.rule_ids, ...altCapIds(line)])];
  const at = new Map(lawRules.map((r, i) => [r.id, i]));
  const place = (id: string) => at.get(id) ?? lawRules.length;
  const cover = ids.filter((id) => rule(id)?.category === "covered_expense");
  const limits = ids.filter((id) => rule(id)?.category === "expense_cap").sort((a, b) => place(a) - place(b));
  return [...cover, ...limits, ...ids.filter((id) => !cover.includes(id) && !limits.includes(id))];
}

// The law sets more than one limit here, and which one fits turns on facts Tend does not ask.
export function severalLimits(line: Pick<EngineLine, "alt_cap_rule_ids">): boolean {
  return altCapIds(line).length > 0;
}

// What a state's clothing and bedding rules ask, read from each rule's quote and Tend's summary of
// it. Most pay only for what was kept as evidence (Michigan: "held as evidence of a crime", MCL
// 18.361(2)(j)), and DC's rule names clothing alone. Four rules say so only in the summary: Alaska's
// and Wyoming's quotes sit under a source heading about items taken as evidence, which their
// pinpoints name, and Texas's limit cites the seized-as-evidence article only by number.
// Massachusetts, Texas, and Louisiana also pay for what the investigation made unusable. Ohio pays
// only for clothing removed to check for or treat injuries (ORC 2743.51(T)(1)), and Washington for
// clothing or footwear lost or damaged in emergency treatment (RCW 7.68.074). New Jersey pays for
// clothing and bedding only as part of crime scene clean-up (N.J.A.C. 13:75-4.12(d)), as Tend's
// summary says; the sentences Tend quotes for New York set no condition. A yes is what counts the
// cost, so the question and the Check name the condition only when every rule that pays for it sets
// one, and name bedding only when one of those rules does.
export type ClothingCondition =
  "evidence" | "investigation" | "evidenceClothing" | "removedForCare" | "emergencyCare" | "cleanup";

const EVIDENCE = /\bevidence\b|\bevidentiary\b|\bseized\b/i;
const CLEANUP = /\bclean-?\s?up\b/i;
const UNUSABLE = /\bunusable\b/i;
const BEDDING = /\bbedding\b/i;
const CARE = /\bmedical\b|\btreat(ed|ment)?\b/i;
const REMOVED = /\bremoved\b/i;
const EMERGENCY = /\bemergency\b/i;

export function clothingCondition(ids: readonly string[], rule: Lookup): ClothingCondition | null {
  const pays = ids
    .map((id) => rule(id))
    .filter(
      (r): r is Rule =>
        (r?.category === "covered_expense" || r?.category === "expense_cap") &&
        (r.expense ?? r.params?.expense) === "clothing_bedding",
    );
  const says = (r: Rule, words: RegExp) => words.test(r.quote) || words.test(r.summary);
  const all = (words: RegExp) => pays.length > 0 && pays.every((r) => says(r, words));
  const bedding = pays.some((r) => says(r, BEDDING));
  if (all(EVIDENCE)) {
    if (pays.some((r) => says(r, UNUSABLE))) return "investigation";
    return bedding ? "evidence" : "evidenceClothing";
  }
  // After the evidence check on purpose: Connecticut's rules name cleanup too, but pay only for
  // clothes and bedding held as evidence.
  if (all(CLEANUP)) return "cleanup";
  // The medical care rules (Ohio's and Washington's) name clothing only.
  if (bedding || !all(CARE)) return null;
  return all(REMOVED) ? "removedForCare" : all(EMERGENCY) ? "emergencyCare" : null;
}
