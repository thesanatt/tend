// The Check summary as data: every fact names the rules behind it. Dates and police-report status
// come from the law engine's checks; lists, caps, and contacts come from the verified rules. The
// component turns this into sentences in the survivor's language.
import type { EngineOutput, ItemExpense, Jurisdiction, Rule } from "@/lib/types";
import type { CheckAnswers } from "./state";

export type Per = "claim" | "session" | "week" | "hour" | "mile" | "day" | "month" | "item" | "residence" | "scene";

export interface CoveredCost {
  expense: ItemExpense;
  cap: { cents: number; per: Per; countLimit: number | null } | null;
  ruleIds: string[];
}

export type DeadlineFact =
  | { kind: "date"; date: string; late: boolean; fromReport: boolean; canExtend: boolean; ruleIds: string[] }
  | { kind: "span"; years: number | null; months: number | null; days: number | null; ruleIds: string[] }
  | { kind: "unknown"; ruleIds: string[] }
  | { kind: "none" };

export type ReportingFact = {
  status: "met_by_report" | "met_by_exam" | "required" | "not_required" | "depends" | "none";
  alternatives: string[];
  withinDays: number | null;
  ruleIds: string[];
  altRuleIds: string[];
};

export interface CheckSummary {
  st: string;
  name: string;
  apply: string[];
  deadline: DeadlineFact;
  reporting: ReportingFact;
  examNoBill: string[];
  examPayer: { payer: string | null; ruleIds: string[] };
  covered: CoveredCost[];
  totalCap: { cents: number; ruleIds: string[] } | null;
  program: {
    name: string;
    agency: string;
    phone: string | null;
    phoneSourceId: string | null;
    website: string | null;
    applyUrl: string | null;
  };
  acp: { programName: string | null; agency: string | null; coversSexualAssault: boolean; ruleIds: string[] } | null;
  records: string[];
}

const UNIT_PERS: Record<string, Per> = {
  session: "session",
  week: "week",
  hour: "hour",
  mile: "mile",
  day: "day",
  month: "month",
  item: "item",
  claim: "claim",
  residence: "residence",
  crime_scene: "scene",
};

const LIST_ORDER: ItemExpense[] = [
  "medical",
  "counseling",
  "prescription",
  "dental",
  "transportation",
  "lost_wages",
  "childcare",
  "relocation",
  "temporary_housing",
  "security",
  "clothing_bedding",
  "property_replacement",
  "crime_scene_cleanup",
  "legal",
  "tuition",
  "funeral",
];

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const ruleExpense = (r: Rule): string | null => {
  for (const v of [r.expense, r.params?.expense]) if (typeof v === "string" && v) return v;
  return null;
};
const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).filter((x): x is string => typeof x === "string" && !!x);

const WHOLE: Per[] = ["claim", "residence", "scene"];

function covered(law: Jurisdiction): CoveredCost[] {
  const ruleIds = new Map<string, string[]>();
  const caps = new Map<string, { cents: number; per: Per; countLimit: number | null }[]>();
  for (const r of law.rules) {
    const expense = ruleExpense(r);
    if (!expense || !LIST_ORDER.includes(expense as ItemExpense)) continue;
    if (r.category !== "covered_expense" && r.category !== "expense_cap") continue;
    ruleIds.set(expense, [...(ruleIds.get(expense) ?? []), r.id]);
    const cents = num(r.params?.amount_cents);
    const per = UNIT_PERS[String(r.params?.per ?? "")];
    if (r.category === "expense_cap" && cents !== null && per) {
      caps.set(expense, [...(caps.get(expense) ?? []), { cents, per, countLimit: num(r.params?.count_limit) }]);
    }
  }
  return LIST_ORDER.filter((e) => ruleIds.has(e)).map((expense) => {
    // A rate per session or week says more than a lifetime cap. Among several, the most generous is
    // shown, as the engine keeps it; the program decides which provider rate applies.
    const all = caps.get(expense) ?? [];
    const perUnit = all.filter((c) => !WHOLE.includes(c.per));
    const pool = perUnit.length ? perUnit : all;
    const best = pool.reduce<(typeof pool)[number] | null>((a, c) => (!a || c.cents > a.cents ? c : a), null);
    const limits = pool
      .filter((c) => best && c.per === best.per && c.countLimit !== null)
      .map((c) => c.countLimit as number);
    return {
      expense,
      cap: best ? { cents: best.cents, per: best.per, countLimit: limits.length ? Math.max(...limits) : null } : null,
      ruleIds: ruleIds.get(expense)!,
    };
  });
}

function longestSpan(rules: Rule[]): { years: number | null; months: number | null; days: number | null } | null {
  let best: { years: number | null; months: number | null; days: number | null; total: number } | null = null;
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

export function buildCheckSummary(
  law: Jurisdiction,
  output: EngineOutput | null,
  check: CheckAnswers,
  knowsDate: boolean,
): CheckSummary {
  const byCat = (c: string) => law.rules.filter((r) => r.category === c);
  const byId = new Map(law.rules.map((r) => [r.id, r]));

  let deadline: DeadlineFact = { kind: "none" };
  const d = output?.checks.deadline;
  const deadlineRules = (d?.rule_ids ?? []).map((id) => byId.get(id)).filter((r): r is Rule => Boolean(r));
  if (d && d.rule_ids.length) {
    const flags = (d as { flags?: string[] }).flags ?? [];
    const canExtend = byCat("filing_deadline").some((r) => typeof r.params?.extension === "string");
    if (knowsDate && d.deadline_date && (d.status === "ok" || d.status === "late")) {
      deadline = {
        kind: "date",
        date: d.deadline_date,
        late: d.status === "late",
        fromReport: flags.includes("deadline_from_report"),
        canExtend,
        ruleIds: d.rule_ids,
      };
    } else {
      const span = longestSpan(deadlineRules);
      deadline = span ? { kind: "span", ...span, ruleIds: d.rule_ids } : { kind: "unknown", ruleIds: d.rule_ids };
    }
  } else if (byCat("filing_deadline").length) {
    deadline = { kind: "unknown", ruleIds: byCat("filing_deadline").map((r) => r.id) };
  }

  const reportingRules = byCat("reporting_requirement");
  const r = output?.checks.reporting;
  const alternatives = [...new Set(reportingRules.flatMap((x) => list(x.params?.alternatives)))];
  const altRuleIds = reportingRules.filter((x) => list(x.params?.alternatives).length).map((x) => x.id);
  const within = reportingRules.map((x) => num(x.params?.within_days)).filter((n): n is number => n !== null);
  let status: ReportingFact["status"] = "depends";
  if (!reportingRules.length || (r && r.status === "satisfied" && !r.rule_ids.length)) status = "none";
  else if (r?.status === "satisfied") status = check.police === "yes" ? "met_by_report" : "met_by_exam";
  else if (r?.status === "required") status = "required";
  else if (r?.status === "not_required") status = "not_required";
  const reporting: ReportingFact = {
    status,
    alternatives,
    withinDays: within.length ? Math.min(...within) : null,
    ruleIds: r?.rule_ids.length ? r.rule_ids : reportingRules.map((x) => x.id),
    altRuleIds,
  };

  const totals = byCat("total_cap")
    .map((x) => ({ id: x.id, cents: num(x.params?.amount_cents) }))
    .filter((x): x is { id: string; cents: number } => x.cents !== null);
  const smallest = totals.length ? Math.min(...totals.map((x) => x.cents)) : null;

  const acpRule =
    byCat("address_confidentiality").find((x) => x.params?.covers_sexual_assault === true) ??
    byCat("address_confidentiality")[0];
  const payerRule = byCat("exam_payment").find((x) => typeof x.params?.payer === "string");

  return {
    st: law.jurisdiction,
    name: law.name,
    apply: byCat("eligible_crime").map((x) => x.id),
    deadline,
    reporting,
    examNoBill: byCat("exam_no_bill").map((x) => x.id),
    examPayer: { payer: (payerRule?.params?.payer as string | undefined) ?? null, ruleIds: byCat("exam_payment").map((x) => x.id) },
    covered: covered(law),
    totalCap:
      smallest === null ? null : { cents: smallest, ruleIds: totals.filter((x) => x.cents === smallest).map((x) => x.id) },
    program: {
      name: law.program.program_name,
      agency: law.program.agency,
      phone: law.program.phone ?? null,
      phoneSourceId: law.program.phone_source_id ?? null,
      website: law.program.website || null,
      applyUrl: law.program.apply_url ?? null,
    },
    acp: acpRule
      ? {
          programName: typeof acpRule.params?.program_name === "string" ? acpRule.params.program_name : null,
          agency: typeof acpRule.params?.agency === "string" ? acpRule.params.agency : null,
          coversSexualAssault: acpRule.params?.covers_sexual_assault === true,
          ruleIds: [acpRule.id],
        }
      : null,
    records: byCat("record_confidentiality").map((x) => x.id),
  };
}
