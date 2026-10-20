// What the survivor flow, the packet and the advocate view may say about the exam bill, the police
// report and the total, read from the same params the state page reads (components/public/summary.ts,
// rules/SCHEMA.md). A sentence says no more than the rule behind it: where a rule carries a scope or a
// condition the flow cannot check, the flow says "may" and shows the rule's own terms.
import type { Jurisdiction, Rule } from "./types";

type Params = Record<string, unknown>;

const params = (r: Rule): Params => (r.params ?? {}) as Params;

const phrase = (r: Rule, key: string): string | null => {
  const v = params(r)[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

const list = (r: Rule, key: string): string[] => {
  const v = params(r)[key];
  return (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).filter(
    (x): x is string => typeof x === "string" && !!x,
  );
};

const expenseOf = (r: Rule): string | null => {
  const e = params(r).expense ?? r.expense;
  return typeof e === "string" && e ? e : null;
};

const unique = (rules: Rule[]) => [...new Set(rules.map((r) => r.id))];

// A rule about someone or something other than the survivor's claim (applies_to) is set aside by the
// normalizer and never speaks for her, even before the law IR loads.
export function activeRule(r: Rule, setAside?: Set<string>): boolean {
  return !setAside?.has(r.id) && !params(r).applies_to;
}

// Statutes and regulations are law; everything else is a program page or form.
const LAW_KINDS = new Set(["statute", "regulation"]);

export function sourceIsLaw(law: Jurisdiction, r: Rule): boolean {
  return LAW_KINDS.has(law.sources.find((s) => s.id === r.source_id)?.kind ?? "");
}

// "Michigan law" or "Massachusetts's program", in English, for letters that go to a US billing office.
export function whoSays(law: Jurisdiction, r: Rule): string {
  return sourceIsLaw(law, r) ? `${law.name} law` : `${law.name}'s program`;
}

export interface ExamHold {
  // The no-bill rules that hold for the survivor.
  noBill: Rule[];
  // True only where every no-bill rule is unconditional and the first one is law: the flow may then say
  // "Don't pay this line". Anywhere else (a scope, a condition, a program page, only a payment rule, or
  // no law loaded) it says to check the rule first.
  plain: boolean;
  // The rules' own scope and condition as the state page's exam line says them, in English. Null when
  // the hold is plain, or when the rules carry different ones and the rules themselves must say when.
  terms: string | null;
  // The rules that carry the scope or condition first, then the no-bill rules (or the payment rules,
  // where there is no no-bill rule).
  ruleIds: string[];
  // The rule a hold quotes: the no-bill rule that carries the scope or condition, else the first.
  lead: Rule | null;
  // The rules that carry a scope or condition, no-bill or payment.
  narrowing: Rule[];
}

export function examHold(law: Jurisdiction | null | undefined, setAside?: Set<string>): ExamHold {
  if (!law) return { noBill: [], plain: false, terms: null, ruleIds: [], lead: null, narrowing: [] };
  const of = (c: string) => law.rules.filter((r) => r.category === c && activeRule(r, setAside));
  const noBill = of("exam_no_bill");
  const payment = of("exam_payment");
  const scoped = noBill.filter((r) => phrase(r, "scope"));
  // A condition may sit on a payment rule (Maryland's 15-day window), as on the state page.
  const conditioned = [...noBill, ...payment].filter((r) => phrase(r, "condition"));
  const scopes = [...new Set(scoped.map((r) => phrase(r, "scope")!))];
  const conds = [...new Set(conditioned.map((r) => phrase(r, "condition")!))];
  const narrowed = scoped.length > 0 || conditioned.length > 0;
  const lead = noBill.find((r) => phrase(r, "scope") || phrase(r, "condition")) ?? noBill[0] ?? null;
  const plain = noBill.length > 0 && !narrowed && sourceIsLaw(law, noBill[0]);
  const terms =
    narrowed && noBill.length && scopes.length <= 1 && conds.length <= 1
      ? `You should not have to pay for ${scopes[0] ?? "a sexual assault forensic exam"}${conds[0] ? ` ${conds[0]}` : ""}.`
      : null;
  return {
    noBill,
    plain,
    terms,
    ruleIds: unique([...conditioned, ...(noBill.length ? noBill : payment)]),
    lead,
    narrowing: [...new Set([...scoped, ...conditioned])],
  };
}

// The reporting rules whose other records the flow may list: not a rule about something narrower
// (scope), and not a waiver for the forensic exam alone (expense forensic_exam), as on the state page.
export function reportAltRules(law: Jurisdiction, setAside?: Set<string>): Rule[] {
  return law.rules.filter(
    (r) =>
      r.category === "reporting_requirement" &&
      activeRule(r, setAside) &&
      !phrase(r, "scope") &&
      expenseOf(r) !== "forensic_exam" &&
      list(r, "alternatives").length > 0,
  );
}

// An exam counts for the report only within a limit the flow does not ask about (Connecticut's 120
// hours), only sometimes (Rhode Island), or a criminal charge is generally needed too (West Virginia).
// The rules that say so are returned, to be cited.
export function examCountsIf(law: Jurisdiction, setAside?: Set<string>): Rule[] {
  const rules = law.rules.filter((r) => r.category === "reporting_requirement" && activeRule(r, setAside));
  const limited = reportAltRules(law, setAside).filter(
    (r) =>
      list(r, "alternatives").includes("forensic_exam") &&
      (phrase(r, "exam_condition") || list(r, "waiver_records").includes("forensic_exam")),
  );
  return [...limited, ...rules.filter((r) => params(r).charge_required === true)];
}

// The rules that make the total "in most cases": the lead total's own exception or condition, a higher
// tier another total cap states, or a payment the law keeps outside the total, as on the state page.
export function totalHedgeRules(law: Jurisdiction, lead: string[], setAside?: Set<string>): Rule[] {
  const totals = law.rules.filter((r) => r.category === "total_cap");
  const leads = totals.filter((r) => lead.includes(r.id));
  const amount = (r: Rule) => {
    const v = params(r).amount_cents;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const min = Math.min(...leads.map((r) => amount(r) ?? Infinity));
  const own = leads.filter((r) => phrase(r, "exception") || phrase(r, "condition"));
  const tier = own.some((r) => phrase(r, "exception"))
    ? []
    : totals
        .filter((r) => !lead.includes(r.id) && !params(r).applies_to && phrase(r, "exception"))
        .filter((r) => amount(r) === null || (amount(r)! > min && activeRule(r, setAside)))
        .slice(0, 1);
  const outside = law.rules.filter((r) => params(r).outside_total_cap === true && activeRule(r, setAside));
  return [...own, ...tier, ...outside];
}
