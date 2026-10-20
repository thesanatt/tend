// The filing deadline a survivor plans around. The engine's deadline check (docs/SPEC.md step 10)
// uses the longest deadline rule, so it never turns anyone away. As a date to file by, though, the
// longest can be a window only some people get: good cause in Florida (FL-DEADLINE-3), a sexually
// violent crime in Kansas (KS-DEAD-2). So the flow and the packet lead with the general rule, the
// one the state page leads with (components/public/summary.ts deadlineSection): the first deadline
// rule counted from the day it happened that the law IR keeps. Where every rule counts from a later
// day (Washington, Maryland), the first timed rule is the general one. The date comes from the IR's
// days, the way the engine dates it, and the engine's longer date is kept to say that some cases
// have until then. The engine flags a deadline counted from the report or from discovery when any
// rule is. The report and discovery notes follow only the general rule's own provision, so a rule
// for people who were children when it happened (MI-FILE-2) does not tell every survivor "the law
// counts from your report". A flag from another rule is kept as laterElsewhere, and a passed date is
// then never shown as plainly late (docs/SPEC.md v1.3): whether that rule fits turns on what Tend
// never asks, such as age at the time of the crime (MI-FILE-2, KS-DEAD-4, MN-DEADLINE-2, NJ-FILE-3)
// or a crime found out more than three years later (MA-DEAD-3).
import { addDays, isIsoDay } from "./dates";
import type { EngineChecks, Jurisdiction, Rule } from "./types";

// The parts of public/data/ir/ST.json this reads (rules/tools/normalize.py writes it).
export interface LawIr {
  rules: { id: string; kind: string; days?: number; from?: string }[];
  skipped?: { id: string; reason: string }[];
}

export interface GeneralRule {
  rule: Rule;
  days: number;
  // The provision counts from the report or from discovery (the engine dates it from the incident).
  fromReport: boolean;
  fromDiscovery: boolean;
}

export interface FileBy extends GeneralRule {
  date: string;
  // The engine's date, when it is later: some cases have until then.
  longer: string | null;
  // Another deadline rule counts from the report or from discovery, and the general rule does not.
  laterElsewhere: boolean;
  // The general rule first, then the engine's other deadline rules.
  ruleIds: string[];
}

// A length of time as a rule writes it.
export interface Span {
  years: number | null;
  months: number | null;
  days: number | null;
}

export interface SpanBy extends Span {
  // Another of the engine's deadline rules allows more time.
  longer: boolean;
  ruleIds: string[];
  fromReport: boolean;
  fromDiscovery: boolean;
}

type Check = Pick<EngineChecks["deadline"], "deadline_date" | "rule_ids" | "flags">;

const FROM_INCIDENT = new Set(["crime", "incident", "injury", "offense", "occurrence"]);
const LOWER_LIMIT = /^less generous duplicate of /;

const timed = (r: Rule) =>
  (["years", "months", "days"] as const).some((k) => typeof r.params?.[k] === "number" && (r.params[k] as number) > 0);

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

export function generalDeadlineRule(law: Jurisdiction, ir: LawIr): GeneralRule | null {
  const setAside = new Set((ir.skipped ?? []).filter((s) => !LOWER_LIMIT.test(s.reason)).map((s) => s.id));
  const active = law.rules.filter((r) => r.category === "filing_deadline" && !setAside.has(r.id));
  const rules = active.filter(timed);
  const rule = rules.find((r) => FROM_INCIDENT.has(String(r.params?.from ?? ""))) ?? rules[0];
  const compiled = (id: string) => ir.rules.find((r) => r.id === id && r.kind === "deadline");
  const own = rule ? compiled(rule.id) : undefined;
  if (!rule || !own || typeof own.days !== "number" || own.days <= 0) return null;
  // A provision the IR splits in two keeps its other start day: Maine's "within 3 years ..., or within
  // 60 days of the discovery ..., whichever is later" is ME-DEAD-1 and ME-DEAD-2.
  const anchors = active
    .filter((r) => r.pinpoint === rule.pinpoint || r.quote === rule.quote)
    .map((r) => compiled(r.id)?.from);
  return {
    rule,
    days: own.days,
    fromReport: anchors.includes("report"),
    fromDiscovery: anchors.includes("discovery"),
  };
}

export function generalDeadline(law: Jurisdiction, ir: LawIr, incident: string, check: Check | null): FileBy | null {
  const general = generalDeadlineRule(law, ir);
  if (!general || !isIsoDay(incident)) return null;
  const date = addDays(incident, general.days);
  const engine = check?.deadline_date ?? null;
  const flags = check?.flags ?? [];
  return {
    ...general,
    date,
    longer: engine && isIsoDay(engine) && engine > date ? engine : null,
    laterElsewhere:
      (flags.includes("deadline_from_report") && !general.fromReport) ||
      (flags.includes("deadline_from_discovery") && !general.fromDiscovery),
    ruleIds: [general.rule.id, ...(check?.rule_ids ?? []).filter((id) => id !== general.rule.id)],
  };
}

export function longestSpan(rules: Rule[]): Span | null {
  let best: (Span & { total: number }) | null = null;
  for (const r of rules) {
    const years = num(r.params?.years);
    const months = num(r.params?.months);
    const days = num(r.params?.days);
    const total = (years ?? 0) * 365 + (months ?? 0) * 30 + (days ?? 0);
    if (!total) continue;
    if (!best || total > best.total) best = { years, months, days, total };
  }
  return best ? { years: best.years, months: best.months, days: best.days } : null;
}

// With no date to count from, the general rule's length of time, as the rule writes it. Without the
// IR, the longest of the engine's deadline rules, with the engine's flags.
export function generalSpan(law: Jurisdiction, ir: LawIr | null, check: Omit<Check, "deadline_date">): SpanBy | null {
  const general = ir ? generalDeadlineRule(law, ir) : null;
  const byId = new Map(law.rules.map((r) => [r.id, r]));
  const engineRules = check.rule_ids.map((id) => byId.get(id)).filter((r): r is Rule => Boolean(r));
  const span = longestSpan(general ? [general.rule] : engineRules);
  if (!span) return null;
  const days = (id: string) => ir?.rules.find((r) => r.id === id && r.kind === "deadline")?.days ?? 0;
  const flags = check.flags ?? [];
  return {
    ...span,
    longer: Boolean(general && check.rule_ids.some((id) => days(id) > general.days)),
    ruleIds: general ? [general.rule.id, ...check.rule_ids.filter((id) => id !== general.rule.id)] : check.rule_ids,
    fromReport: general ? general.fromReport : flags.includes("deadline_from_report"),
    fromDiscovery: general ? general.fromDiscovery : flags.includes("deadline_from_discovery"),
  };
}

// "5 years", or "1 year and 6 months", in the caller's language.
export function spanText(
  s: Span,
  units: { years(n: number): string; months(n: number): string; days(n: number): string },
  and: (items: string[]) => string,
): string {
  const parts = [
    s.years ? units.years(s.years) : null,
    s.months ? units.months(s.months) : null,
    s.days ? units.days(s.days) : null,
  ].filter((p): p is string => Boolean(p));
  return and(parts);
}
