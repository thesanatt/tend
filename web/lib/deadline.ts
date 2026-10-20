// The filing deadline a survivor plans around. The engine's deadline check (docs/SPEC.md step 10)
// uses the longest deadline rule, so it never turns anyone away. As a date to file by, though, the
// longest can be a window only some people get: good cause in Florida (FL-DEADLINE-3), a sexually
// violent crime in Kansas (KS-DEAD-2). So the flow and the packet lead with the general rule, the
// one the state page leads with (components/public/summary.ts deadlineSection): the first deadline
// rule counted from the day it happened that the law IR keeps. Where every rule counts from a later
// day (Washington, Maryland), the first timed rule is the general one. The date is counted the way
// the rule writes it, in calendar years, months, and days, not from the IR's days: normalize.py turns
// a month into 30 days, so Nevada's "60 months" would land almost a month early. The longest of the
// engine's rules, dated the same way, is kept to say that some cases have until then. The engine
// flags a deadline counted from the report or from discovery when any rule is. The report and
// discovery notes follow only the general rule's own provision, so a rule for people who were
// children when it happened (MI-FILE-2) does not tell every survivor "the law counts from your report". A flag from another rule is kept as laterElsewhere, and a passed date is
// then never shown as plainly late (docs/SPEC.md v1.3): whether that rule fits turns on what Tend
// never asks, such as age at the time of the crime (MI-FILE-2, KS-DEAD-4, MN-DEADLINE-2, NJ-FILE-3)
// or a crime found out more than three years later (MA-DEAD-3). A general rule with its own condition
// (Virginia's 3 years are for a crime on or after July 1, 2025) keeps it, and every reader shows it
// with the date, as the state page does, unless the date given settles it.
import { addDays, addMonths, addYears, isIsoDay } from "./dates";
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
  // The rule's own condition (params.condition), in English, or null.
  condition: string | null;
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
  condition: string | null;
}

type Check = Pick<EngineChecks["deadline"], "deadline_date" | "rule_ids" | "flags">;

const FROM_INCIDENT = new Set(["crime", "incident", "injury", "offense", "occurrence"]);
const LOWER_LIMIT = /^less generous duplicate of /;

const timed = (r: Rule) =>
  (["years", "months", "days"] as const).some((k) => typeof r.params?.[k] === "number" && (r.params[k] as number) > 0);

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

const whole = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 0);

const conditionOf = (r: Rule): string | null => {
  const v = r.params?.condition;
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

// The general rule's condition as one English sentence, for RuleTerms and the PDF.
export const deadlineTerms = (condition: string): string => `The rule gives this deadline ${condition}.`;

// A condition the date itself settles: "for a crime on or after July 1, 2025" (Virginia, Florida). Any
// other wording, such as Nebraska's age, stays a condition Tend cannot check.
const ON_OR_AFTER = /^for a crime on or after ([A-Z][a-z]+) (\d{1,2}), (\d{4})$/;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function conditionStart(condition: string): string | null {
  const m = ON_OR_AFTER.exec(condition);
  const month = m ? MONTHS.indexOf(m[1]) + 1 : 0;
  if (!m || !month) return null;
  const day = `${m[3]}-${String(month).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return isIsoDay(day) ? day : null;
}

type Compiled = LawIr["rules"][number];

const compiledDeadline = (ir: LawIr, id: string): Compiled | undefined =>
  ir.rules.find((r) => r.id === id && r.kind === "deadline");

// The last day of a rule's window, counted from `from`: years, then months (clamped to the end of the
// month), then days. The IR's days are used only when the rule's params give no whole number.
export function ruleEnd(rule: Rule, from: string, irDays: number): string {
  const years = whole(rule.params?.years);
  const months = whole(rule.params?.months);
  const days = whole(rule.params?.days);
  if (!years && !months && !days) return addDays(from, irDays);
  let end = from;
  if (years) end = addYears(end, years);
  if (months) end = addMonths(end, months);
  if (days) end = addDays(end, days);
  return end;
}

// The latest end among the engine's deadline rules the IR keeps, as calendar dates.
function latestEnd(law: Jurisdiction, ir: LawIr, from: string, ruleIds: string[]): string | null {
  const byId = new Map(law.rules.map((r) => [r.id, r]));
  let last: string | null = null;
  for (const id of ruleIds) {
    const rule = byId.get(id);
    const own = compiledDeadline(ir, id);
    if (!rule || !own || typeof own.days !== "number" || own.days <= 0) continue;
    const end = ruleEnd(rule, from, own.days);
    if (!last || end > last) last = end;
  }
  return last;
}

export function generalDeadlineRule(law: Jurisdiction, ir: LawIr): GeneralRule | null {
  const setAside = new Set((ir.skipped ?? []).filter((s) => !LOWER_LIMIT.test(s.reason)).map((s) => s.id));
  // A deadline counted from a trip is for one travel request, not the application (WA-COV-TRANSPORT-3),
  // as on the state page.
  const active = law.rules.filter(
    (r) => r.category === "filing_deadline" && !setAside.has(r.id) && r.params?.from !== "trip",
  );
  const rules = active.filter(timed);
  const rule = rules.find((r) => FROM_INCIDENT.has(String(r.params?.from ?? ""))) ?? rules[0];
  const compiled = (id: string) => compiledDeadline(ir, id);
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
    condition: conditionOf(rule),
  };
}

export function generalDeadline(law: Jurisdiction, ir: LawIr, incident: string, check: Check | null): FileBy | null {
  const general = generalDeadlineRule(law, ir);
  if (!general || !isIsoDay(incident)) return null;
  const date = ruleEnd(general.rule, incident, general.days);
  // The engine's own date counts a month as 30 days, so its longest rule is dated here as well. The
  // engine's date stands only when none of its rules is in the IR.
  const engine = check?.deadline_date ?? null;
  const last = latestEnd(law, ir, incident, check?.rule_ids ?? []) ?? (engine && isIsoDay(engine) ? engine : null);
  const flags = check?.flags ?? [];
  // A crime on or after the rule's start day meets its condition; an earlier one may have another deadline.
  const start = general.condition ? conditionStart(general.condition) : null;
  return {
    ...general,
    condition: start && incident >= start ? null : general.condition,
    date,
    longer: last && last > date ? last : null,
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
  const flags = check.flags ?? [];
  // Compared as calendar spans from one day, so 12 months is not shorter than 1 year.
  const REF = "2001-01-01";
  const generalEnd = general ? ruleEnd(general.rule, REF, general.days) : null;
  return {
    ...span,
    longer: Boolean(general && ir && generalEnd && (latestEnd(law, ir, REF, check.rule_ids) ?? REF) > generalEnd),
    ruleIds: general ? [general.rule.id, ...check.rule_ids.filter((id) => id !== general.rule.id)] : check.rule_ids,
    fromReport: general ? general.fromReport : flags.includes("deadline_from_report"),
    fromDiscovery: general ? general.fromDiscovery : flags.includes("deadline_from_discovery"),
    condition: general ? general.condition : null,
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
