// The public summary of one state's program, built only from its verified rules.
// Every sentence a reader sees carries the ids of the rules (or, for the program phone, the
// source) it came from. Templated sentences use rule params, which verify.py checks against the
// quote; everything else is the rule's own plain summary. Tend's own notes are marked "note".
// A templated sentence says no more than the rules it cites: a condition, scope, exception or
// extension in a cited rule's params is carried into the sentence. No templated sentence says
// "never", and the exam tile says "$0" only where every exam rule behind it is unconditional.
import { expenseRank } from "@/lib/expenses";
import { formatCentsShort } from "@/lib/money";
import type { Jurisdiction, Rule } from "@/lib/types";
import type { IrRule, IrSummary } from "./types";

export type FactKind = "law" | "note";

export interface Fact {
  key: string;
  // Short bold lead-in, e.g. "Counseling" or "Email".
  label?: string;
  text: string;
  cites: string[];
  kind: FactKind;
  // True when text is a rule's own summary (the disclosure then shows only the quote).
  verbatimSummary?: boolean;
  // Rule summaries shown under the line, e.g. each limit on a kind of cost with its conditions.
  details?: { text: string; cite: string }[];
  href?: string;
}

export interface Section {
  id: string;
  title: string;
  // Short name for the page's jump links.
  nav: string;
  facts: Fact[];
}

export interface KeyFact {
  id: "total" | "deadline" | "report" | "exam";
  big: string;
  small: string;
  cites: string[];
}

export interface ShareClause {
  id: "total" | "covered" | "report" | "exam" | "deadline";
  text: string;
  cites: string[];
}

export interface StateSummary {
  st: string;
  name: string;
  // How the share line names the place: "Michigan", "DC".
  place: string;
  programName: string;
  agency: string;
  phone: Fact | null;
  keyFacts: KeyFact[];
  sections: Section[];
  share: { text: string; clauses: ShareClause[] };
}

// Optional per-state notes in Tend's own voice, keyed by section id (jurisdiction file field
// "page_notes"). They are shown first in their section, styled as notes, with no citation.
type PageNotes = Partial<Record<string, string>>;

// A section's page note as a line, or null where the jurisdiction has none for it.
export function sectionNote(law: Jurisdiction, id: string): Fact | null {
  const text = ((law as unknown as { page_notes?: PageNotes }).page_notes ?? {})[id];
  return text ? { key: `${id}-note`, text, cites: [], kind: "note" } : null;
}

// Literal names for each kind of cost. The ledger's labels ("Rides to care") say more than some
// rules do, for example a rule that covers travel to court.
const EXPENSE_LABEL: Record<string, string> = {
  medical: "Medical care",
  forensic_exam: "Forensic exam",
  counseling: "Counseling",
  lost_wages: "Lost pay",
  transportation: "Travel",
  relocation: "Moving",
  temporary_housing: "Temporary housing",
  security: "Home security",
  crime_scene_cleanup: "Crime scene cleanup",
  childcare: "Child care",
  property_replacement: "Replacing belongings",
  clothing_bedding: "Clothing and bedding",
  prescription: "Prescriptions",
  dental: "Dental care",
  funeral: "Funeral costs",
  legal: "Legal help",
  tuition: "Lost tuition",
};

export function expenseName(expense: string): string {
  return EXPENSE_LABEL[expense] ?? capitalize(expense.replace(/_/g, " "));
}

const ALTERNATIVE_PHRASE: Record<string, string> = {
  forensic_exam: "a forensic exam",
  protective_order: "a protective order",
  medical_provider: "medical records",
  advocate: "an advocate's statement",
};
const ALTERNATIVE_ORDER = ["forensic_exam", "protective_order", "medical_provider", "advocate"];
const METHOD_LABEL: Record<string, string> = {
  online: "Online",
  email: "Email",
  mail: "Mail",
  fax: "Fax",
  in_person: "In person",
};
const METHOD_ORDER = ["online", "email", "mail", "fax", "in_person"];
// Deadlines counted from these start on the day it happened.
const FROM_INCIDENT = new Set(["crime", "incident", "injury", "offense", "occurrence"]);
// Source kinds that are law; everything else is a program page or form.
const LAW_KINDS = new Set(["statute", "regulation"]);
// The share line's limit, the same as web/tests/public-summary.test.ts.
export const SHARE_WORD_LIMIT = 32;
// The card's report clause where every award needs a police report and no record replaces it.
export const ASKS_FOR_REPORT = "the program asks for a police report";
// The card's report clause where a criminal charge is generally needed and an exam cannot replace it
// (West Virginia 14-2A-18). Like ASKS_FOR_REPORT, it always takes the card's second slot.
export const NEEDS_CHARGE = "the program generally needs a criminal charge to be filed";
// The card's report clause where every award needs a report but the program may waive it, in its
// discretion, for a survivor who had a forensic exam (Iowa r. 61-9.29(4)(c), a waiver_records rule). It is
// not a gate: like any other clause it is left out when the card has no room.
export const EXAM_SOMETIMES = "a forensic exam can sometimes count instead of a police report";

export function placeName(st: string, name: string): string {
  return st === "DC" ? "DC" : name;
}

export function plural(n: number, [one, many]: [string, string]): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

export function money(cents: number): string {
  return formatCentsShort(cents);
}

function params(r: Rule): Record<string, unknown> {
  return (r.params ?? {}) as Record<string, unknown>;
}

function expenseOf(r: Rule): string | null {
  const e = params(r).expense ?? r.expense;
  return typeof e === "string" && e ? e : null;
}

function list(r: Rule, key: string): string[] {
  const v = params(r)[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return typeof v === "string" && v ? [v] : [];
}

function num(r: Rule, key: string): number | null {
  const v = params(r)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// A plain-text param (condition, scope, exception, extension, exam_condition, item), or null.
function phrase(r: Rule, key: string): string | null {
  const v = params(r)[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// The one value every rule that has the param shares; null when none has it, "mixed" when they differ.
function shared(rules: Rule[], key: string): { value: string | null; rules: Rule[]; mixed: boolean } {
  const withIt = rules.filter((r) => phrase(r, key));
  const values = [...new Set(withIt.map((r) => phrase(r, key)!))];
  return { value: values.length === 1 ? values[0] : null, rules: withIt, mixed: values.length > 1 };
}

// "a, b, and c"
export function joinWords(words: string[], conj = "and"): string {
  if (words.length <= 1) return words.join("");
  if (words.length === 2) return `${words[0]} ${conj} ${words[1]}`;
  return `${words.slice(0, -1).join(", ")}, ${conj} ${words.at(-1)}`;
}

function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// Durations as the law states them; whole years read better than "60 months".
export function duration(r: Rule): { text: string; days: number } | null {
  const years = num(r, "years");
  const months = num(r, "months");
  const days = num(r, "days");
  const asYears = (y: number) => ({ text: plural(y, ["year", "years"]), days: y * 365 + Math.floor(y / 4) });
  if (years && years > 0) return asYears(years);
  if (months && months > 0) {
    return months % 12 === 0 ? asYears(months / 12) : { text: plural(months, ["month", "months"]), days: months * 30 };
  }
  if (days && days > 0) return { text: plural(days, ["day", "days"]), days };
  return null;
}

// A reporting window as written: within_hours, within_days or within_months.
function reportWindow(r: Rule): string | null {
  const h = num(r, "within_hours");
  const d = num(r, "within_days");
  const m = num(r, "within_months");
  if (h) return plural(h, ["hour", "hours"]);
  if (d) return plural(d, ["day", "days"]);
  if (m) return plural(m, ["month", "months"]);
  return null;
}

class Corpus {
  readonly rules: Rule[];
  private ir: Map<string, IrRule> | null;
  private skipped: Map<string, string>;

  constructor(
    readonly law: Jurisdiction,
    irSummary: IrSummary | null,
  ) {
    this.rules = law.rules;
    this.ir = irSummary ? new Map(irSummary.rules.map((r) => [r.id, r])) : null;
    this.skipped = new Map((irSummary?.skipped ?? []).map((s) => [s.id, s.reason]));
  }

  of(category: string): Rule[] {
    return this.rules.filter((r) => r.category === category);
  }

  irRule(id: string): IrRule | undefined {
    return this.ir?.get(id);
  }

  // Set aside by the normalizer because it is about someone or something other than the survivor's claim.
  setAside(r: Rule): boolean {
    if (this.ir) return this.skipped.has(r.id) && !this.lowerLimit(r) && !this.amountless(r);
    return Boolean(params(r).applies_to);
  }

  // A cap the normalizer kept beside a more generous one for the same cost.
  lowerLimit(r: Rule): boolean {
    return /^less generous duplicate of /.test(this.skipped.get(r.id) ?? "");
  }

  // A limit with no dollar amount (a session or week count, a share of the award). The engine never
  // applies it; the page shows it under its cost's row.
  amountless(r: Rule): boolean {
    return r.category === "expense_cap" && !num(r, "amount_cents") && Boolean(expenseOf(r)) && !params(r).applies_to;
  }

  // Whole-category exclusions the engine applies (an excluded rule with no narrowing tags).
  excludesAll(expense: string): Rule[] {
    return this.of("excluded_expense").filter((r) => {
      const ir = this.irRule(r.id);
      if (this.ir) return ir?.kind === "excluded" && ir.expense === expense && !(ir.tags && ir.tags.length);
      return expenseOf(r) === expense && !params(r).item;
    });
  }
}

function summaryFacts(rules: Rule[], keyPrefix: string): Fact[] {
  return rules.map((r) => ({
    key: `${keyPrefix}-${r.id}`,
    text: sentence(r.summary),
    cites: [r.id],
    kind: "law" as const,
    verbatimSummary: true,
  }));
}

function totalSection(c: Corpus): { facts: Fact[]; key: KeyFact | null; clause: ShareClause | null } {
  const all = c.of("total_cap").filter((r) => num(r, "amount_cents"));
  // Total caps with no amount (NV-CAP-3: some services can be paid beyond the limit) and total caps
  // set aside as someone else's or a special case (TN-CAP-2, WY-CAP-10) are shown in their own words.
  const noAmount = c.of("total_cap").filter((r) => !num(r, "amount_cents"));
  const decision = all.filter((r) => c.irRule(r.id)?.kind === "total_cap" || (!c.irRule(r.id) && !c.setAside(r)));
  if (!decision.length) return { facts: summaryFacts([...all, ...noAmount], "total"), key: null, clause: null };
  // The engine applies the smallest total cap (docs/SPEC.md step 8).
  const min = Math.min(...decision.map((r) => num(r, "amount_cents")!));
  const lead = decision.filter((r) => num(r, "amount_cents") === min);
  const leadExc = lead.map((r) => ({ r, t: phrase(r, "exception") })).find((x) => x.t);
  // A higher tier or an added award for the survivor that another total cap states in its own quote
  // (Arkansas 16-90-716(a)(2), Wyoming 1-40-109(e), Maryland 11-811(b)(1)(ii)) hedges the total with that
  // rule's exception. The rule is cited after the lead and is not repeated below the line.
  const exc =
    leadExc ??
    c
      .of("total_cap")
      .filter((r) => !lead.includes(r) && !params(r).applies_to)
      .filter((r) => (num(r, "amount_cents") === null ? true : num(r, "amount_cents")! > min && !c.setAside(r)))
      .map((r) => ({ r, t: phrase(r, "exception") }))
      .find((x) => x.t);
  const cond = lead.map((r) => ({ r, t: phrase(r, "condition") })).find((x) => x.t);
  // A cost that is the only one some survivors can get also bounds what they can ask for in total
  // (Florida: counseling for adults who were not physically hurt). Its rule says, in its own words,
  // whom the total is for, and the tile and the card carry it.
  const only = c
    .of("covered_expense")
    .find((r) => !c.setAside(r) && phrase(r, "only_benefit_if") && phrase(r, "total_condition"));
  const tc = only ? phrase(only, "total_condition") : null;
  // Payments the law keeps outside the total (MA-EXAM-6, VA-EXAM-7).
  const outside = c.rules.filter((r) => params(r).outside_total_cap === true && !c.setAside(r));
  const shownAbove = (r: Rule) => r === exc?.r && !lead.includes(r);
  const rest = all.filter((r) => !lead.includes(r) && !shownAbove(r));
  // The rule whose quote holds the exception or condition is cited first, so the card prints it; a
  // higher tier from another rule follows the lead, whose amount the line states.
  const first = [leadExc?.r, cond?.r].filter((r): r is Rule => Boolean(r));
  const cites = [...new Set([...first, ...lead, ...(exc && !leadExc ? [exc.r] : [])].map((r) => r.id))];
  const hedged = Boolean(exc) || outside.length > 0;
  const line =
    hedged || cond
      ? `The most the program can pay in total is ${money(min)}${cond ? `, ${cond.t}` : ""}${exc ? `, ${exc.t}` : ""}.`
      : `The most the program can pay for all costs together is ${money(min)}.`;
  const facts: Fact[] = [{ key: "total", text: line, cites, kind: "law" }];
  if (outside.length) {
    const names = [
      ...new Set(
        outside.map((r) =>
          (expenseOf(r) ?? "forensic_exam") === "forensic_exam"
            ? "the forensic exam"
            : expenseName(expenseOf(r)!).toLowerCase(),
        ),
      ),
    ];
    facts.push({
      key: "total-outside",
      text: `Payments for ${joinWords(names)} do not count toward this limit.`,
      cites: outside.map((r) => r.id),
      kind: "law",
    });
  }
  facts.push(
    ...summaryFacts(rest, "total"),
    ...summaryFacts(
      noAmount.filter((r) => !shownAbove(r)),
      "total-over",
    ),
  );
  const who = tc ? ` ${tc}` : "";
  const small = `the most you can ask for in total${cond ? `, ${cond.t}` : ""}${who}${exc ? ", except in some cases" : ""}`;
  const keyCites = only ? [...cites, only.id] : cites;
  return {
    facts,
    key: { id: "total", big: money(min), small, cites: keyCites },
    // A dated or conditioned total does not fit the card; the covered clause takes its place.
    clause: cond
      ? null
      : {
          id: "total",
          text: `you can ask for up to ${money(min)}${who}${exc ? ", or more in some cases" : ""}`,
          cites: keyCites,
        },
  };
}

export interface CoveredRow {
  expense: string;
  label: string;
  covered: Rule[];
  // Limits on the cost. Each is shown with its own summary, because a limit often holds only
  // for one kind of provider or trip (a peer counselor's hourly rate is not a therapist's).
  caps: Rule[];
  // True when the label or the row's first details come from the rules' scope or item, so the row
  // is narrower than its cost type and the card never names it.
  scoped: boolean;
  scopeDetails: { text: string; cite: string }[];
}

function coveredRows(c: Corpus): CoveredRow[] {
  const rows = new Map<string, CoveredRow>();
  const others: CoveredRow[] = [];
  const active = (r: Rule) => !c.setAside(r);
  const caps = c.of("expense_cap").filter((r) => !c.setAside(r));

  for (const r of c.of("covered_expense").filter(active)) {
    const e = expenseOf(r);
    if (!e || e === "forensic_exam") continue;
    const item = phrase(r, "item");
    if (e === "other") {
      // "Other" only says something when the rule names the item. Its limits are the "other"
      // caps that name the same item.
      if (item) {
        others.push({
          expense: e,
          label: capitalize(item),
          covered: [r],
          caps: caps.filter(
            (x) => expenseOf(x) === "other" && phrase(x, "item") === item && (num(x, "amount_cents") ?? 0) > 0,
          ),
          scoped: true,
          // A scope on a named "other" cost (TN-PAIN-1: rape and other sexual crimes) shows as the rule's own words.
          scopeDetails: phrase(r, "scope") ? [{ text: sentence(r.summary), cite: r.id }] : [],
        });
      }
      continue;
    }
    const row = rows.get(e) ?? {
      expense: e,
      label: expenseName(e),
      covered: [],
      caps: [],
      scoped: false,
      scopeDetails: [],
    };
    row.covered.push(r);
    rows.set(e, row);
  }

  for (const e of new Set(caps.map(expenseOf).filter((x): x is string => Boolean(x)))) {
    if (e === "forensic_exam" || e === "other") continue;
    const mine = caps.filter((r) => expenseOf(r) === e && (num(r, "amount_cents") ?? 0) > 0);
    const row = rows.get(e) ?? {
      expense: e,
      label: expenseName(e),
      covered: [],
      caps: [],
      scoped: false,
      scopeDetails: [],
    };
    row.caps = mine;
    // A cap with an amount names the cost as payable, the same way the engine reads it.
    if (row.covered.length || row.caps.length) rows.set(e, row);
  }
  // A limit with no amount joins a row that already exists; it never makes a cost payable.
  for (const r of caps.filter((x) => c.amountless(x))) {
    const row = rows.get(expenseOf(r)!);
    if (row && !row.caps.includes(r)) row.caps.push(r);
  }

  for (const row of rows.values()) {
    const scopes = row.covered.map((r) => ({ r, s: phrase(r, "scope") }));
    if (row.covered.length && scopes.every((x) => x.s)) {
      const distinct = [...new Set(scopes.map((x) => x.s!))];
      row.scoped = true;
      // One scope names the row, unless a limit on the row is about something else: a limit with its own
      // scope (West Virginia's court travel) or limits for different items (Wisconsin's evidence property).
      // Then, as with several scopes, the row keeps the cost's name and each rule's own summary says what
      // it covers.
      const items = new Set(row.caps.map((r) => phrase(r, "item")).filter(Boolean));
      const otherLimits = row.caps.some((r) => phrase(r, "scope")) || items.size > 1;
      if (distinct.length === 1 && !otherLimits) row.label = capitalize(distinct[0]);
      else row.scopeDetails = row.covered.map((r) => ({ text: sentence(r.summary), cite: r.id }));
    } else if (scopes.some((x) => x.s)) {
      // A row with a general rule and narrower ones keeps the cost's name, and each narrower rule's own
      // summary shows under it (GA-6: counseling paid only from a licensed or certified professional).
      row.scopeDetails = scopes.filter((x) => x.s).map(({ r }) => ({ text: sentence(r.summary), cite: r.id }));
    } else if (!row.covered.length) {
      // A row made only by limits takes its name from them when they all name one item (OH-CAP-4).
      const items = [...new Set(row.caps.map((r) => phrase(r, "item")))];
      if (items.length === 1 && items[0]) {
        row.label = capitalize(items[0]);
        row.scoped = true;
      }
    }
  }

  return [...rows.values()]
    .filter((row) => !c.excludesAll(row.expense).length)
    .sort((a, b) => expenseRank(a.expense) - expenseRank(b.expense))
    .concat(others);
}

// rowFacts holds each row's line, in the order of rows.
function coveredSection(c: Corpus): { facts: Fact[]; rows: CoveredRow[]; rowFacts: Fact[] } {
  const rows = coveredRows(c);
  const facts: Fact[] = rows.map((row) => {
    // Covered rules marked detail: true show their own summary under the row (IN-COV-1: paid at 75%).
    const own = row.covered
      .filter((r) => params(r).detail === true)
      .map((r) => ({ text: sentence(r.summary), cite: r.id }));
    const details = [...row.scopeDetails, ...own, ...row.caps.map((r) => ({ text: sentence(r.summary), cite: r.id }))];
    return {
      key: `covered-${row.expense}-${row.covered[0]?.id ?? row.caps[0]?.id}`,
      label: row.label,
      text: "",
      cites: [...row.covered, ...row.caps].map((r) => r.id),
      kind: "law" as const,
      details: details.length ? details : undefined,
    };
  });
  // A covered cost the normalizer set aside as someone else's (a parent's counseling, a caregiver's
  // travel) shows in its own words after the rows, so the page still says what it covers (ME-TRANS-1).
  const setAside = c.of("covered_expense").filter((r) => c.setAside(r) && expenseOf(r) !== "forensic_exam");
  return { facts: [...facts, ...summaryFacts(setAside, "covered-aside")], rows, rowFacts: facts };
}

function coveredClause(rows: CoveredRow[]): ShareClause | null {
  // Two costs keep the card's one sentence short enough to read at a glance. A row narrowed by a
  // scope or item is never named on the card, because its bare cost name would say more.
  const pick = rows.filter((r) => r.expense !== "other" && r.covered.length && !r.scoped).slice(0, 2);
  if (!pick.length) return null;
  return {
    id: "covered",
    text: `you can ask to be paid back for costs like ${joinWords(pick.map((r) => r.label.toLowerCase()))}`,
    // The row's limits are cited first: in Iowa they hold the general grants (Iowa Code 915.86(1) for
    // medical care, 915.86(15) for travel), while its covered rules are narrower (IA-1).
    cites: [
      ...new Set(pick.flatMap((r) => [...r.caps.filter((x) => num(x, "amount_cents")), ...r.covered].map((x) => x.id))),
    ],
  };
}

// One line on insurance, from the first value any no-bill rule carries in this order. "It" is the
// exam the line above names, with its scope and condition. The bar and the consent line name private
// health insurance only when every rule behind the line does (Mississippi R. 602(3), New York), or,
// for consent, when another exam rule of the state bills Medicaid or Medicare with no choice (New
// Hampshire Jus 605.13(c)(3)). Elsewhere they say "insurance", as the rules do (Michigan's "insurance
// carrier", Minnesota's "insurer", Wisconsin's "insurance or another available source of payment").
const INSURANCE_LINE: [string, string][] = [
  ["prohibited", "the provider should not bill your {insurance} for it either"],
  ["consent_required", "your {insurance} can be billed for it only if you agree"],
  ["required", "if you have health insurance, it should be billed first"],
  ["allowed", "the provider may bill your insurance for it, but not you"],
];

// insurance is the line on billing insurance that follows the headline, also in facts.
function examSection(c: Corpus): {
  facts: Fact[];
  key: KeyFact | null;
  clause: ShareClause | null;
  insurance: Fact | null;
} {
  const noBill = c.of("exam_no_bill").filter((r) => !c.setAside(r));
  // A no-bill rule the normalizer set aside holds only for some survivors (Wyoming's covers exams reported to
  // police), so it is shown in its own words and never as the headline.
  const narrow = c.of("exam_no_bill").filter((r) => c.setAside(r));
  const payment = c.of("exam_payment").filter((r) => !c.setAside(r));
  const coveredExam = c.of("covered_expense").filter((r) => expenseOf(r) === "forensic_exam" && !c.setAside(r));
  const examCaps = c.of("expense_cap").filter((r) => expenseOf(r) === "forensic_exam" && !c.setAside(r));
  const facts: Fact[] = [];
  let key: KeyFact | null = null;
  let clause: ShareClause | null = null;
  let insurance: Fact | null = null;

  // The headline says no more than every no-bill rule. A scope narrows what the exam covers (Texas:
  // the forensic part and the kit); a condition narrows who or when (Alaska: 16 or older). A
  // condition may sit on a payment rule (Maryland's 15-day window), which is then cited first.
  const scope = shared(noBill, "scope");
  const cond = shared([...noBill, ...payment], "condition");
  const headline = noBill.length > 0 && !scope.mixed && !cond.mixed;

  if (headline) {
    const s = scope.value;
    const k = cond.value ? ` ${cond.value}` : "";
    const cites = [...new Set([...cond.rules, ...noBill].map((r) => r.id))];
    // A no-bill rule that carries the condition, or is marked detail, shows its own summary under the
    // headline, because the plain condition leaves out its waivers (Arkansas: minors, good cause).
    const details = noBill
      .filter((r) => cond.rules.includes(r) || params(r).detail === true)
      .map((r) => ({ text: sentence(r.summary), cite: r.id }));
    facts.push({
      key: "exam-no-bill",
      text: `You should not have to pay for ${s ?? "a sexual assault forensic exam"}${k}.`,
      cites,
      kind: "law",
      details: details.length ? details : undefined,
    });
    key =
      s || cond.value
        ? { id: "exam", big: "Forensic exam", small: `you should not have to pay for ${s ?? "it"}${k}`, cites }
        : { id: "exam", big: money(0), small: "what the forensic exam itself should cost you", cites };
    clause = { id: "exam", text: `you should not have to pay for ${s ?? "a forensic exam"}${k}`, cites };

    for (const [value, line] of INSURANCE_LINE) {
      const rules = noBill.filter((r) => params(r).insurance_billing === value);
      if (!rules.length) continue;
      const publicBilled =
        value === "consent_required" &&
        [...noBill, ...payment].some((r) => !rules.includes(r) && /\b(medicaid|medicare)\b/i.test(r.quote));
      const text = line.replace(
        "{insurance}",
        publicBilled || rules.every((r) => /\bprivate\b/i.test(r.quote)) ? "private health insurance" : "insurance",
      );
      // A bar or consent rule that holds only under its own condition starts the line with it
      // (Wisconsin 949.26(2)(b) binds a provider that asks the SAFE Fund to pay).
      const lc = value === "prohibited" || value === "consent_required" ? shared(rules, "condition") : null;
      insurance = {
        key: `exam-insurance-${value}`,
        text: sentence(lc?.value ? `${capitalize(lc.value)}, ${text}` : capitalize(text)),
        cites: [...new Set([...(lc?.rules ?? []), ...rules].map((r) => r.id))],
        kind: "law",
      };
      facts.push(insurance);
      break;
    }
  } else {
    facts.push(...summaryFacts(noBill, "exam-no-bill"));
  }
  facts.push(
    ...summaryFacts(narrow, "exam-no-bill"),
    ...summaryFacts(payment, "exam-payment"),
    ...summaryFacts(coveredExam, "exam-covered"),
    ...summaryFacts(examCaps, "exam-cap"),
  );
  return { facts, key, clause, insurance };
}

// Conduct rules about cooperating with police or the program belong next to the report rules.
function cooperationRules(c: Corpus): Rule[] {
  return c.of("conduct_reduction").filter((r) => !c.setAside(r) && /cooperat/i.test(`${r.quote} ${r.summary}`));
}

// lead is the section's first line, also in facts. leadNamesRecords is true where the key fact says only that
// other records count and the lead names some of them ("like a forensic exam or a protective order").
function reportSection(c: Corpus): {
  facts: Fact[];
  key: KeyFact | null;
  clause: ShareClause | null;
  lead: Fact | null;
  leadNamesRecords: boolean;
} {
  const rules = c.of("reporting_requirement").filter((r) => !c.setAside(r));
  const coop = cooperationRules(c);
  if (!rules.length && !coop.length) return { facts: [], key: null, clause: null, lead: null, leadNamesRecords: false };
  // The rules that answer "does the compensation program need a police report": not a rule about
  // something narrower (scope: cooperation, another program, a source that disagrees with the
  // statute) and not a waiver for the forensic exam alone (expense forensic_exam).
  const main = rules.filter((r) => !phrase(r, "scope") && expenseOf(r) !== "forensic_exam");
  const required = main.filter((r) => params(r).required === true);
  // An exam counts with confidence only where the law that sets the requirement names it.
  const examInRequired = required.filter((r) => list(r, "alternatives").includes("forensic_exam"));
  // The exam's own limit ("done within 120 hours of the assault"). Two different limits cannot be
  // said as one, so the tile then says only that other records count, and the card leaves it out.
  const ec = shared(examInRequired, "exam_condition");
  const reqWithAlts = required.filter((r) => list(r, "alternatives").length);
  const waivers = main.filter((r) => params(r).required === false && list(r, "alternatives").length);
  // A criminal charge the exam cannot replace (West Virginia 14-2A-18).
  const charge = rules.filter((r) => params(r).charge_required === true);
  // One plain line before the rules themselves, from params only. Two examples at most keep it
  // short; the rules below list every one.
  const alts = ALTERNATIVE_ORDER.filter((a) => main.some((r) => list(r, "alternatives").includes(a)));
  const altRules = main.filter((r) => list(r, "alternatives").some((a) => alts.includes(a)));
  const like = joinWords(
    alts.slice(0, 2).map((a) => ALTERNATIVE_PHRASE[a]),
    "or",
  );
  const facts = [...summaryFacts(rules, "report"), ...summaryFacts(coop, "report-coop")];
  let key: KeyFact | null = null;
  let clause: ShareClause | null = null;
  let lead: Fact | null = null;
  let leadNamesRecords = false;
  // Where a required rule names other records, the lead asks only that the crime be reported: Georgia
  // counts a report to an investigating agency or medical authorities, and Missouri a forensic exam, as
  // the report itself (GA-1, MO-3).
  const askLead = (cites: Rule[]): Fact => ({
    key: "report-lead",
    text: `The program asks that the crime be reported. The rules below say what can count besides a police report, like ${like}.`,
    cites: [...new Set(cites.map((r) => r.id))],
    kind: "law",
  });

  if (!main.length) {
    // Only narrower rules: each shows in its own words.
  } else if (!required.length) {
    // "Not required" alone overstates a rule like KS-REP-1 (a report within 72 hours OR an exam
    // within 7 days), which the corpus marks required: false because an alternative exists. When
    // the rules name alternatives, the page says a report is not the only way, which holds for both.
    // A rule that names other records and sets a window keeps the window on the tile and the lead
    // (Kansas 74-7305: a report within 72 hours, an exam within 7 days, or good cause; KS-0).
    const altWin = altRules.map((r) => reportWindow(r)).find((w) => w) ?? null;
    key = {
      id: "report",
      big: "Police report",
      small: alts.length
        ? `not the only record that counts${altWin ? ", but time limits apply" : ""}`
        : "not required to apply",
      cites: main.map((r) => r.id),
    };
    lead = {
      key: "report-lead",
      text: alts.length
        ? `A police report${altWin ? ` within ${altWin}` : ""} is not the only way to qualify. The rules below say which other records can count and when, like ${like}.`
        : "A police report is not required.",
      cites: main.map((r) => r.id),
      kind: "law",
    };
    leadNamesRecords = alts.length > 0;
  } else if (examInRequired.length && charge.length) {
    const r0 = examInRequired[0];
    const win = reportWindow(r0);
    const exc = phrase(r0, "exception");
    const cites = [...examInRequired, ...charge].map((r) => r.id);
    key = {
      id: "report",
      big: "Report or exam",
      small: `${win ? `within ${win}` : "the program asks for one"}${exc ? `, ${exc}` : ""}; a criminal charge is generally needed too`,
      cites,
    };
    lead = {
      key: "report-lead",
      text: "The program asks for a police report, and generally for a criminal charge to be filed. The rules below say when a forensic exam can count for the report, and when no charge is needed.",
      cites: [...new Set([...required, ...charge].map((r) => r.id))],
      kind: "law",
    };
    // A charge an anonymous survivor may not have decides whether she can be paid at all, so the card
    // says so in its second slot, as it does where every award needs a report (WV-REP-2).
    clause = { id: "report", text: NEEDS_CHARGE, cites: [...new Set([...charge, ...examInRequired].map((r) => r.id))] };
  } else if (examInRequired.length && !ec.mixed) {
    // A rule stored as a waiver whose own words make the exam count (Illinois 6.1(b-1)) is cited before
    // the required rule, so the card and the tile point to the text that says so (IL-0).
    const inLieu = waivers.filter((r) => list(r, "alternatives").includes("forensic_exam"));
    const cites = [...new Set([...ec.rules, ...inLieu, ...examInRequired].map((r) => r.id))];
    // Where the rule's own words only let the program allow the claim after an exam, in its discretion
    // (Rhode Island 12-25-22(a): "shall have the authority to allow"), it is marked waiver_records too, and
    // the tile and the card say the exam counts only sometimes, as Iowa's card does.
    const sometimes = examInRequired.some((r) => list(r, "waiver_records").includes("forensic_exam"));
    key = {
      id: "report",
      big: "Exam can count",
      small: `in place of a police report${sometimes ? " in some cases" : ""}${ec.value ? `, if it was ${ec.value}` : ""}`,
      cites,
    };
    clause = {
      id: "report",
      text: `a forensic exam${ec.value ? ` ${ec.value}` : ""} can ${sometimes ? "sometimes " : ""}count instead of a police report`,
      cites,
    };
    lead = askLead([...required, ...altRules]);
  } else if (reqWithAlts.length) {
    // A required rule that names its own other records (Utah's advocate questionnaire).
    const timedReq = required.filter((r) => reportWindow(r));
    key = {
      id: "report",
      big: "Police report",
      small: `not the only record that counts${timedReq.length ? ", but time limits apply" : ""}`,
      // The rule whose window makes time limits apply is cited too (Massachusetts c. 258C, s. 2(b)).
      cites: [...new Set([...waivers, ...reqWithAlts, ...timedReq].map((r) => r.id))],
    };
    lead = askLead([...required, ...altRules]);
    leadNamesRecords = true;
    // Where none of those other records is one an anonymous adult can get on her own (Delaware 9010(a)(5):
    // protective services, Family Court, a protection order, cooperation with police, the Agency's
    // discretion), the rule is marked report_gate and the card says a report is asked for, as in the
    // states where every award needs one.
    const gated = required.filter((r) => params(r).report_gate === true);
    if (gated.length)
      clause = {
        id: "report",
        text: ASKS_FOR_REPORT,
        cites: [...new Set([...gated, ...required].map((r) => r.id))],
      };
  } else {
    // Every award needs a report: the card says so in place of an exam or deadline clause.
    const timed = required.map((r) => ({ r, w: reportWindow(r) })).find((x) => x.w);
    // Every required rule's exception, the timed rule's first (Arizona: counted from discovery, then the
    // Board's good-cause extension in R10-4-106(B); New Jersey: discovery, then good cause).
    const excRules = [...(timed ? [timed.r] : []), ...required.filter((r) => r !== timed?.r)].filter((r) =>
      phrase(r, "exception"),
    );
    const exc = [...new Set(excRules.map((r) => phrase(r, "exception")!))].join(", ") || null;
    // The rule that sets the requirement leads, the first in the file, so the tile and the card show its
    // pinpoint (Hawaii HRS 351-31(d), not the 72-hour definition in Haw. Admin. R. 23-605-2; Texas
    // 56B.053(a), not its child exception). The timed rule and the exceptions follow, then the rest.
    const cites = [
      ...new Set([...required.slice(0, 1), ...(timed ? [timed.r] : []), ...excRules, ...required].map((r) => r.id)),
    ];
    key = {
      id: "report",
      big: "Police report",
      small: `the program asks for one${timed ? ` within ${timed.w}` : ""}${exc ? `, ${exc}` : ""}`,
      cites,
    };
    // A rule whose own words let the program waive the report for a survivor who had a forensic exam
    // (Iowa r. 61-9.29(4)(c), marked waiver_records) makes the card say the exam can sometimes count,
    // citing that rule first; it does not take the card's second slot by force.
    const waived = required.filter((r) => list(r, "waiver_records").includes("forensic_exam"));
    clause = waived.length
      ? { id: "report", text: EXAM_SOMETIMES, cites: [...new Set([...waived, ...required].map((r) => r.id))] }
      : { id: "report", text: ASKS_FOR_REPORT, cites };
    // The lead follows the rules that set the requirement. Waivers that name other records (South
    // Carolina's anonymous route in program papers) show below in their own words, and a page note says
    // where they disagree with the law.
    lead = {
      key: "report-lead",
      text: "The program asks that the crime be reported to police.",
      cites: required.map((r) => r.id),
      kind: "law",
    };
  }
  return { facts: lead ? [lead, ...facts] : facts, key, clause, lead, leadNamesRecords };
}

function deadlineSection(c: Corpus): { facts: Fact[]; key: KeyFact | null; clause: ShareClause | null } {
  // A deadline counted from a trip is for one travel request, not for the application. It shows last
  // and never makes the application's deadline read as having exceptions (WA-COV-TRANSPORT-3).
  const perTrip = (r: Rule) => params(r).from === "trip";
  const rules = c.of("filing_deadline").filter((r) => !c.setAside(r) && !perTrip(r));
  const trips = c.of("filing_deadline").filter((r) => !c.setAside(r) && perTrip(r));
  // Deadline rules the normalizer set aside hold for some survivors only (Mississippi: child sexual abuse,
  // counted from the report). They show in their own words after the others (MS-4).
  const narrow = c.of("filing_deadline").filter((r) => c.setAside(r));
  const timed = rules
    .map((r) => ({ r, d: duration(r), from: String(params(r).from ?? "") }))
    .filter((x) => x.d !== null);
  // The headline deadline counts from the day it happened and is the program's general rule: the
  // first such rule in the verified corpus, where research lists the general deadline before its
  // exceptions. Neither the shortest nor the longest works as a stand-in. The shortest would lead
  // Virginia with a 1-year window that only covers crimes before July 2025 (VA-DEADLINE-3), and the
  // longest would lead Florida with 5 years that need good cause (FL-DEADLINE-3). Every other window
  // follows as its own rule. The engine's check uses the longest (docs/SPEC.md step 10), so it never
  // turns someone away; the two answer different questions.
  const primary = timed.find((x) => FROM_INCIDENT.has(x.from));
  const facts: Fact[] = [];
  let key: KeyFact | null = null;
  let clause: ShareClause | null = null;
  if (primary) {
    const others = [...rules.filter((r) => r !== primary.r), ...narrow];
    const cond = phrase(primary.r, "condition");
    // An extension from the rule's own quote: a clause ("or later if the board finds good cause")
    // joins the sentence; a sentence (New Mexico's minors) follows it.
    const ext = phrase(primary.r, "extension");
    const extClause = ext && /^[a-z]/.test(ext) ? ext : null;
    const extSentence = ext && !extClause ? sentence(ext) : null;
    // A rule counted from discovery that quotes the headline rule's own sentence says what the
    // extension already says (Maine's 60 days, 5 M.R.S. 3360-C(1)(B)); the headline cites it instead of
    // repeating it below.
    const same = (r: Rule) =>
      Boolean(ext) && params(r).from === "discovery" && r.quote.trim() === primary.r.quote.trim();
    const below = [...others.filter((r) => !same(r)), ...trips];
    const more = below.length ? (ext ? " The rules below say more." : " The rules below cover other cases.") : "";
    facts.push({
      key: "deadline",
      text: `Apply within ${primary.d!.text} of the date it happened${cond ? `, ${cond}` : ""}${extClause ? `, ${extClause}` : ""}.${extSentence ? ` ${extSentence}` : ""}${more}`,
      cites: [primary.r.id, ...others.filter(same).map((r) => r.id)],
      kind: "law",
    });
    const hedge = Boolean(ext) || others.length > 0;
    // The tile and the card cite the rules that make "with exceptions" true, after the headline rule,
    // whose pinpoint they show (Alaska: the program page that asks late applicants to explain).
    const cites = [primary.r.id, ...(hedge ? others.map((r) => r.id) : [])];
    key = {
      id: "deadline",
      big: primary.d!.text,
      small: `to apply, from the date it happened${cond ? `, ${cond}` : ""}${hedge ? ", with exceptions" : ""}`,
      cites,
    };
    // The card's hedge can only say "more". Where another window counted from the day it happened is
    // shorter (Virginia's 1 year for crimes from July 2001 through June 2025, VA-DEADLINE-3), the card says
    // nothing about the deadline; the tile and the line above name the headline's own condition.
    const shorter = timed.some((x) => x.r !== primary.r && FROM_INCIDENT.has(x.from) && x.d!.days < primary.d!.days);
    clause = shorter
      ? null
      : {
          id: "deadline",
          text: `you have ${primary.d!.text} to apply${cond ? ` ${cond}` : ""}${hedge ? ", or more in some cases" : ""}`,
          cites,
        };
    facts.push(...summaryFacts(below, "deadline"));
  } else {
    facts.push(...summaryFacts([...rules, ...narrow, ...trips], "deadline"));
  }
  // With no deadline rule at all, the section says so in Tend's own words.
  if (!facts.length)
    facts.push({
      key: "deadline-none",
      text: `Tend has not verified a filing deadline for ${c.law.name}. Ask the program before you wait.`,
      cites: [],
      kind: "note",
    });
  return { facts, key, clause };
}

// Filing targets are kept as the program wrote them; only typographic marks become plain ASCII.
export function plainMarks(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s*\u2022\s*/g, ", ");
}

function contactFacts(law: Jurisdiction, c: Corpus): { phone: Fact | null; facts: Fact[] } {
  const { program } = law;
  const sources = new Map(law.sources.map((s) => [s.id, s]));
  const facts: Fact[] = [];
  const submissions = c
    .of("submission")
    .filter((r) => !c.setAside(r))
    .map((r) => ({
      r,
      method: String(params(r).method ?? ""),
      target: plainMarks(String(params(r).target ?? "").trim()),
      // Who may use this way to file (Virginia's WebFile is for trained advocates).
      cond: phrase(r, "condition"),
    }))
    // A mail target with no digit is not an address a survivor can mail to.
    .filter((x) => METHOD_LABEL[x.method] && x.target && (x.method !== "mail" || /\d/.test(x.target)))
    .sort(
      (a, b) =>
        Number(Boolean(a.cond)) - Number(Boolean(b.cond)) ||
        METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method),
    );
  for (const { r, method, target, cond } of submissions) {
    let href: string | undefined;
    if (method === "online" && /^https?:\/\//i.test(target)) href = target;
    if (method === "email" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) href = `mailto:${target}`;
    facts.push({
      key: `apply-${r.id}`,
      label: METHOD_LABEL[method],
      text: cond ? `${target} (${cond})` : target,
      cites: [r.id],
      kind: "law",
      href,
    });
  }

  // The phone is shown only with the saved page it came from.
  let phone: Fact | null = null;
  const sourceId = program.phone_source_id && sources.has(program.phone_source_id) ? program.phone_source_id : null;
  if (program.phone && sourceId) {
    phone = {
      key: "phone",
      label: "Phone",
      text: program.phone,
      cites: [sourceId],
      kind: "law",
      href: `tel:${program.phone.replace(/[^\d+]/g, "")}`,
    };
    facts.push(phone);
  }
  return { phone, facts };
}

// The privacy section's title says only what its rules cover.
function privacyTitle(acp: boolean, records: boolean): string {
  if (acp && records) return "Keeping your name and address private";
  if (acp) return "Keeping your address private";
  if (records) return "Keeping your claim records private";
  return "Keeping your name and address private";
}

function partsOf(c: Corpus) {
  return {
    total: totalSection(c),
    covered: coveredSection(c),
    exam: examSection(c),
    report: reportSection(c),
    deadline: deadlineSection(c),
  };
}

// What a state page's key facts and its costs, exam, police, and deadline sections are built from, before
// the page adds its notes and puts them in order. /compare (components/public/compare.ts) shows the same parts
// for every program side by side, so the two pages never say different things.
export type StateParts = ReturnType<typeof partsOf>;

export function stateParts(law: Jurisdiction, ir: IrSummary | null): StateParts {
  return partsOf(new Corpus(law, ir));
}

export function buildStateSummary(law: Jurisdiction, ir: IrSummary | null): StateSummary {
  const c = new Corpus(law, ir);
  const st = law.jurisdiction;
  const place = placeName(st, law.name);

  const { total, covered, exam, report, deadline } = partsOf(c);
  const contact = contactFacts(law, c);
  const excluded = c.of("excluded_expense").filter((r) => !c.setAside(r));
  const acp = c.of("address_confidentiality");
  const records = [...c.of("record_confidentiality"), ...c.of("record_public")];
  const privacy = [...acp, ...records];
  const urgent = c.of("emergency_award").filter((r) => !c.setAside(r));
  const before = [
    ...c.of("residency"),
    ...c.of("collateral_source"),
    ...c.of("minimum_loss").filter((r) => !c.setAside(r)),
    ...c.of("financial_need").filter((r) => !c.setAside(r)),
  ];

  // Tend's own notes say what it could not verify. They carry no citation and are styled apart.
  const note = (key: string, text: string): Fact[] => [{ key, text, cites: [], kind: "note" }];
  const withNote = (id: string, facts: Fact[]): Fact[] => {
    const first = sectionNote(law, id);
    return first ? [first, ...facts] : facts;
  };
  const privacyNotes: Fact[] = [];
  if (acp.length && !records.length)
    privacyNotes.push(
      ...note(
        "privacy-records-none",
        `Tend has not verified a law that keeps compensation records private in ${law.name}.`,
      ),
    );
  if (!acp.length && records.length)
    privacyNotes.push(
      ...note("privacy-address-none", `Tend has not verified an address confidentiality program for ${law.name}.`),
    );
  // A cost that is the only one some survivors can get (Florida: counseling for adults who were not
  // physically hurt) is said right under the total, citing its rule.
  const only: Fact[] = c
    .of("covered_expense")
    .filter((r) => !c.setAside(r) && phrase(r, "only_benefit_if") && expenseOf(r))
    .map((r) => ({
      key: `costs-only-${r.id}`,
      text: `${capitalize(phrase(r, "only_benefit_if")!)}, ${expenseName(expenseOf(r)!).toLowerCase()} is the only cost the program can pay.`,
      cites: [r.id],
      kind: "law" as const,
    }));
  const all: Section[] = [
    {
      id: "costs",
      title: "What the program can pay for",
      nav: "Costs",
      facts: withNote("costs", [...total.facts, ...only, ...covered.facts]),
    },
    {
      id: "not-covered",
      title: "What it does not pay for",
      nav: "Not covered",
      facts: summaryFacts(excluded, "excluded"),
    },
    { id: "exam", title: "The forensic exam", nav: "Exam", facts: withNote("exam", exam.facts) },
    { id: "police", title: "Police report", nav: "Police report", facts: withNote("police", report.facts) },
    { id: "deadline", title: "Deadline to apply", nav: "Deadline", facts: withNote("deadline", deadline.facts) },
    {
      id: "privacy",
      title: privacyTitle(acp.length > 0, records.length > 0),
      nav: "Privacy",
      facts: withNote(
        "privacy",
        privacy.length
          ? [...summaryFacts(privacy, "privacy"), ...privacyNotes]
          : note("privacy-none", `Tend has not verified an address or records privacy law for ${law.name} yet.`),
      ),
    },
    { id: "apply", title: "How to apply", nav: "How to apply", facts: contact.facts },
    {
      id: "urgent",
      title: "If you need money soon",
      nav: "Urgent money",
      facts: withNote("urgent", summaryFacts(urgent, "urgent")),
    },
    {
      id: "before",
      title: "Good to know before you apply",
      nav: "Good to know",
      facts: summaryFacts(before, "before"),
    },
  ];
  const sections = all.filter((s) => s.facts.length);

  const keyFacts = [total.key, deadline.key, report.key, exam.key].filter((k): k is KeyFact => k !== null);

  // "If you're Jane Doe in Michigan: <money>, and <one protection>." Where every award needs a
  // police report (or the only other records are ones an anonymous adult cannot get, report_gate), or a
  // criminal charge, the protection clause says so. Otherwise the first protection
  // clause that keeps the sentence within the word limit is used: an exam that counts for the report,
  // then the exam itself, then the deadline. A clause is never cut down to fit; it is left out instead.
  const first = total.clause ?? coveredClause(covered.rows);
  const head = `If you're Jane Doe in ${place}:`;
  const sentenceOf = (cl: ShareClause[]) => `${head} ${clauseText(cl)}`;
  const firstOnly = first ? [first] : [];
  const candidates = [report.clause, exam.clause, deadline.clause].filter((x): x is ShareClause => x !== null);
  const gate = report.clause && [ASKS_FOR_REPORT, NEEDS_CHARGE].includes(report.clause.text) ? report.clause : null;
  const second = gate ?? candidates.find((x) => wordCount(sentenceOf([...firstOnly, x])) <= SHARE_WORD_LIMIT) ?? null;
  const two = [...firstOnly, ...(second ? [second] : [])];
  // Where the gate takes the second slot, the exam clause still follows it when the sentence stays within
  // the word limit (Alabama, Montana, Washington).
  const three = gate && first && exam.clause ? [first, gate, exam.clause] : null;
  const clauses = three && wordCount(sentenceOf(three)) <= SHARE_WORD_LIMIT ? three : two;
  const text = sentenceOf(clauses);

  return {
    st,
    name: law.name,
    place,
    programName: law.program.program_name,
    agency: law.program.agency,
    phone: contact.phone,
    keyFacts,
    sections,
    share: { text, clauses },
  };
}

// The card's clauses as one sentence after "If you're Jane Doe in X:": "A, and B." or "A, B, and C."
// The share text and the card image (og/card.tsx) both use it, so they never read differently.
export function clauseText(clauses: ShareClause[]): string {
  const t = clauses.map((c) => c.text);
  return `${t.length === 3 ? `${t[0]}, ${t[1]}, and ${t[2]}` : t.join(", and ")}.`;
}

// Every rule or source id a summary cites, for the law page links and for tests.
export function citedIds(summary: StateSummary): Set<string> {
  const ids = new Set<string>();
  for (const s of summary.sections) for (const f of s.facts) f.cites.forEach((id) => ids.add(id));
  for (const k of summary.keyFacts) k.cites.forEach((id) => ids.add(id));
  for (const c of summary.share.clauses) c.cites.forEach((id) => ids.add(id));
  return ids;
}

// What the card's small print names (web/app/[st]/card.png/route.tsx passes it to cardSourceLine in
// web/components/public/og/card.tsx): the first pinpoint of each clause, and whether the clauses
// rest on law, on program pages, or on both, judged from every rule each clause cites.
export function cardSources(law: Jurisdiction, clauses: ShareClause[]): { pinpoints: string[]; label: string } {
  const byId = new Map(law.rules.map((r) => [r.id, r]));
  const kinds = new Map(law.sources.map((s) => [s.id, s.kind]));
  const isLaw = clauses
    .flatMap((c) => c.cites)
    .map((id) => LAW_KINDS.has(kinds.get(byId.get(id)?.source_id ?? "") ?? ""));
  const label = isLaw.every(Boolean) ? "law" : isLaw.some(Boolean) ? "law and program pages" : "program pages";
  const pinpoints = [...new Set(clauses.map((c) => byId.get(c.cites[0])?.pinpoint).filter((p): p is string => !!p))];
  return { pinpoints, label };
}
