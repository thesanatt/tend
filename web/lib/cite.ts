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
