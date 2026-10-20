// The Check summary as data: every fact names the rules behind it. Dates and police-report status
// come from the law engine's checks; lists, caps, and contacts come from the verified rules. The
// component turns this into sentences in the survivor's language.
import { clothingCondition, type ClothingCondition } from "@/lib/cite";
import { generalDeadline, generalSpan, type LawIr } from "@/lib/deadline";
import type { Dict, Formatters } from "@/lib/i18n";
import type { EngineOutput, ItemExpense, Jurisdiction, Rule } from "@/lib/types";
import type { CheckAnswers } from "./state";

export type Per = "claim" | "session" | "week" | "hour" | "mile" | "day" | "month" | "item" | "residence" | "scene";

export interface CapFact {
  cents: number | null; // null when the law limits only how many (sessions, weeks)
  per: Per;
  countLimit: number | null;
  countUnit: Per | null;
  // The law also sets a lower limit of the same kind, and which one fits turns on a fact Tend does
  // not ask, such as a trip's length or the kind of provider.
  varies: boolean;
}

export interface CoveredCost {
  expense: ItemExpense;
  cap: CapFact | null;
  ruleIds: string[];
  // For clothing and bedding, the condition every rule that pays for it sets, such as kept as
  // evidence (lib/cite.ts).
  condition: ClothingCondition | null;
}

// The date shown is the general deadline (lib/deadline.ts), or the engine's own date when Tend has no
// general rule or no law IR to date it. The engine's check stays the longest rule, so `open` can be
// true when the shown date has passed: some cases have until `longer`.
export type DeadlineFact =
  | {
      kind: "date";
      date: string;
      late: boolean; // the shown date has passed
      open: boolean; // the engine's check is still ok
      longer: string | null;
      // The rule behind the shown date counts from the report or from discovery.
      fromReport: boolean;
      fromDiscovery: boolean;
      // Another rule does (lib/deadline.ts), so a passed date may not be late.
      laterElsewhere: boolean;
      ruleIds: string[];
    }
  | {
      kind: "span";
      years: number | null;
      months: number | null;
      days: number | null;
      longer: boolean; // another deadline rule allows more time
      ruleIds: string[];
    }
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
  // Total limits that hold only for some claims (a date range, a kind of harm). The engine applies none
  // of them, so the survivor sees each amount and the rule says when it holds.
  totalCapsDepend: { cents: number; ruleIds: string[] }[];
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

// Rules the law IR sets aside because they are about someone else (docs/SPEC.md v1.1: applies_to naming
// anyone other than the victim): a family member's costs, an older crime date range, emotional harm
// only. The engine never applies them, so Check does not show them as the survivor's limits.
export function setAsideIds(ir: { skipped?: { id: string; reason: string }[] } | null | undefined): Set<string> {
  return new Set((ir?.skipped ?? []).filter((s) => /^applies_to\b/.test(s.reason)).map((s) => s.id));
}

function covered(law: Jurisdiction, setAside: Set<string>): CoveredCost[] {
  // The rule that covers a cost leads its citation, then its limits in the law's order (lib/cite.ts).
  const byId = new Map(law.rules.map((r) => [r.id, r]));
  const coverIds = new Map<string, string[]>();
  const capIds = new Map<string, string[]>();
  const caps = new Map<string, { cents: number | null; per: Per; countLimit: number | null }[]>();
  for (const r of law.rules) {
    if (setAside.has(r.id)) continue;
    const expense = ruleExpense(r);
    if (!expense || !LIST_ORDER.includes(expense as ItemExpense)) continue;
    if (r.category !== "covered_expense" && r.category !== "expense_cap") continue;
    const ids = r.category === "covered_expense" ? coverIds : capIds;
    ids.set(expense, [...(ids.get(expense) ?? []), r.id]);
    const cents = num(r.params?.amount_cents);
    const countLimit = num(r.params?.count_limit);
    const per = UNIT_PERS[String(r.params?.per ?? "")];
    if (r.category === "expense_cap" && per && (cents !== null || countLimit !== null)) {
      caps.set(expense, [...(caps.get(expense) ?? []), { cents, per, countLimit }]);
    }
  }
  const ruleIds = (e: string) => [...(coverIds.get(e) ?? []), ...(capIds.get(e) ?? [])];
  return LIST_ORDER.filter((e) => ruleIds(e).length).map((expense) => {
    // A limit on the whole kind of cost applies to every provider; a rate per session or per week often
    // covers one kind of provider, so it is shown only when there is no overall limit. Among several,
    // the most generous is shown, as the engine keeps it; the program decides which one applies. With a
    // lower one of the same kind (Michigan's $1,000 for trips of 50 miles or less, beside $5,000), the
    // line says so and the citation shows each limit. The lower amount is not listed, because in some
    // states it is a family member's limit, not the survivor's.
    const all = caps.get(expense) ?? [];
    const priced = all.filter((c): c is { cents: number; per: Per; countLimit: number | null } => c.cents !== null);
    const whole = priced.filter((c) => WHOLE.includes(c.per));
    const pool = whole.length ? whole : priced.filter((c) => !WHOLE.includes(c.per));
    const best = pool.reduce<(typeof pool)[number] | null>((a, c) => (!a || c.cents > a.cents ? c : a), null);
    const bestWhole = best ? WHOLE.includes(best.per) : true;
    // How many sessions or weeks: the unit is the rate's own, or a counseling session for overall limits.
    const countUnit: Per | null = best && !bestWhole ? best.per : expense === "counseling" ? "session" : null;
    const limits = all
      .filter(
        (c) =>
          c.countLimit !== null && (bestWhole ? WHOLE.includes(c.per) || c.per === countUnit : c.per === best!.per),
      )
      .map((c) => c.countLimit as number);
    const countLimit = countUnit && limits.length ? Math.max(...limits) : null;
    const varies = Boolean(best && pool.some((c) => c.per === best.per && c.cents < best.cents));
    const cap: CapFact | null = best
      ? { cents: best.cents, per: best.per, countLimit, countUnit, varies }
      : countLimit && countUnit
        ? { cents: null, per: countUnit, countLimit, countUnit, varies }
        : null;
    const condition = expense === "clothing_bedding" ? clothingCondition(ruleIds(expense), (id) => byId.get(id)) : null;
    return { expense, cap, ruleIds: ruleIds(expense), condition };
  });
}

// The law IR (lib/deadline.ts) and today in the state's time, for the general deadline. Without the
// IR, the deadline is the engine's own date.
export interface SummaryContext {
  ir?: LawIr | null;
  asOf?: string;
}

export function buildCheckSummary(
  law: Jurisdiction,
  output: EngineOutput | null,
  check: CheckAnswers,
  knowsDate: boolean,
  setAside: Set<string> = new Set(),
  { ir = null, asOf }: SummaryContext = {},
): CheckSummary {
  const byCat = (c: string) => law.rules.filter((r) => r.category === c);

  let deadline: DeadlineFact = { kind: "none" };
  const d = output?.checks.deadline;
  if (d && d.rule_ids.length) {
    const flags = d.flags ?? [];
    if (knowsDate && d.deadline_date && (d.status === "ok" || d.status === "late")) {
      const general = ir && asOf ? generalDeadline(law, ir, check.date, d) : null;
      deadline = general
        ? {
            kind: "date",
            date: general.date,
            late: general.date < asOf!,
            open: d.status === "ok",
            longer: general.longer,
            fromReport: general.fromReport,
            fromDiscovery: general.fromDiscovery,
            laterElsewhere: general.laterElsewhere,
            ruleIds: general.ruleIds,
          }
        : {
            kind: "date",
            date: d.deadline_date,
            late: d.status === "late",
            open: d.status === "ok",
            longer: null,
            fromReport: flags.includes("deadline_from_report"),
            fromDiscovery: flags.includes("deadline_from_discovery"),
            laterElsewhere: false,
            ruleIds: d.rule_ids,
          };
    } else {
      const span = generalSpan(law, ir, d);
      deadline = span
        ? {
            kind: "span",
            years: span.years,
            months: span.months,
            days: span.days,
            longer: span.longer,
            ruleIds: span.ruleIds,
          }
        : { kind: "unknown", ruleIds: d.rule_ids };
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

  const allTotals = byCat("total_cap")
    .map((x) => ({ id: x.id, cents: num(x.params?.amount_cents) }))
    .filter((x): x is { id: string; cents: number } => x.cents !== null);
  const totals = allTotals.filter((x) => !setAside.has(x.id));
  const smallest = totals.length ? Math.min(...totals.map((x) => x.cents)) : null;
  const depend = totals.length ? [] : allTotals.filter((x) => setAside.has(x.id));

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
    examPayer: {
      payer: (payerRule?.params?.payer as string | undefined) ?? null,
      ruleIds: byCat("exam_payment").map((x) => x.id),
    },
    covered: covered(law, setAside),
    totalCap:
      smallest === null
        ? null
        : { cents: smallest, ruleIds: totals.filter((x) => x.cents === smallest).map((x) => x.id) },
    totalCapsDepend: [...new Set(depend.map((x) => x.cents))]
      .sort((a, b) => b - a)
      .map((cents) => ({ cents, ruleIds: depend.filter((x) => x.cents === cents).map((x) => x.id) })),
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

// Sentences built from the data above, in the survivor's language.
export function capText(cost: CoveredCost, t: Dict, f: Formatters): string | null {
  const cap = cost.cap;
  if (!cap) return null;
  const parts = [
    cap.cents !== null ? t.per[cap.per](f.moneyShort(cap.cents)) : null,
    cap.varies ? t.check.capDepends : null,
    cap.countLimit && cap.countUnit ? t.countLimit(cap.countUnit, cap.countLimit) : null,
  ].filter((p): p is string => Boolean(p));
  return parts.length ? parts.join(", ") : null;
}
