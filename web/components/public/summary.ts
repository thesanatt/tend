// The public summary of one state's program, built only from its verified rules.
// Every sentence a reader sees carries the ids of the rules (or, for the program phone, the
// source) it came from. Templated sentences use rule params, which verify.py checks against the
// quote; everything else is the rule's own plain summary. Tend's own notes are marked "note".
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
  tuition: "School costs",
};

export function expenseName(expense: string): string {
  return EXPENSE_LABEL[expense] ?? capitalize(expense.replace(/_/g, " "));
}

const ALTERNATIVE_PHRASE: Record<string, string> = {
  forensic_exam: "a forensic exam",
  protective_order: "a protective order",
  medical_provider: "medical or counseling records",
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
    if (this.ir) return this.skipped.has(r.id) && !this.lowerLimit(r);
    return Boolean(params(r).applies_to);
  }

  // A cap the normalizer kept beside a more generous one for the same cost.
  lowerLimit(r: Rule): boolean {
    return /^less generous duplicate of /.test(this.skipped.get(r.id) ?? "");
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
  const decision = all.filter((r) => c.irRule(r.id)?.kind === "total_cap" || (!c.irRule(r.id) && !c.setAside(r)));
  if (!decision.length) return { facts: summaryFacts(all, "total"), key: null, clause: null };
  // The engine applies the smallest total cap (docs/SPEC.md step 8).
  const min = Math.min(...decision.map((r) => num(r, "amount_cents")!));
  const lead = decision.filter((r) => num(r, "amount_cents") === min);
  const rest = all.filter((r) => !lead.includes(r));
  const cites = lead.map((r) => r.id);
  return {
    facts: [
      {
        key: "total",
        text: `The most the program can pay for all costs together is ${money(min)}.`,
        cites,
        kind: "law",
      },
      ...summaryFacts(rest, "total"),
    ],
    key: { id: "total", big: money(min), small: "the most you can ask for in total", cites },
    clause: { id: "total", text: `you can ask for up to ${money(min)}`, cites },
  };
}

interface CoveredRow {
  expense: string;
  label: string;
  covered: Rule[];
  // Limits with an amount. Each is shown with its own summary, because a limit often holds only
  // for one kind of provider or trip (a peer counselor's hourly rate is not a therapist's).
  caps: Rule[];
}

function coveredRows(c: Corpus): CoveredRow[] {
  const rows = new Map<string, CoveredRow>();
  const others: CoveredRow[] = [];
  const active = (r: Rule) => !c.setAside(r);

  for (const r of c.of("covered_expense").filter(active)) {
    const e = expenseOf(r);
    if (!e || e === "forensic_exam") continue;
    const item = typeof params(r).item === "string" ? String(params(r).item) : "";
    if (e === "other") {
      // "Other" only says something when the rule names the item.
      if (item) others.push({ expense: e, label: capitalize(item), covered: [r], caps: [] });
      continue;
    }
    const row = rows.get(e) ?? { expense: e, label: expenseName(e), covered: [], caps: [] };
    row.covered.push(r);
    rows.set(e, row);
  }

  const caps = c.of("expense_cap").filter((r) => !c.setAside(r));
  for (const e of new Set(caps.map(expenseOf).filter((x): x is string => Boolean(x)))) {
    if (e === "forensic_exam" || e === "other") continue;
    const mine = caps.filter((r) => expenseOf(r) === e && (num(r, "amount_cents") ?? 0) > 0);
    const row = rows.get(e) ?? { expense: e, label: expenseName(e), covered: [], caps: [] };
    row.caps = mine;
    // A cap with an amount names the cost as payable, the same way the engine reads it.
    if (row.covered.length || row.caps.length) rows.set(e, row);
  }

  return [...rows.values()]
    .filter((row) => !c.excludesAll(row.expense).length)
    .sort((a, b) => expenseRank(a.expense) - expenseRank(b.expense))
    .concat(others);
}

function coveredSection(c: Corpus): { facts: Fact[]; rows: CoveredRow[] } {
  const rows = coveredRows(c);
  const facts: Fact[] = rows.map((row) => ({
    key: `covered-${row.expense}-${row.covered[0]?.id ?? row.caps[0]?.id}`,
    label: row.label,
    text: "",
    cites: [...row.covered, ...row.caps].map((r) => r.id),
    kind: "law",
    details: row.caps.length ? row.caps.map((r) => ({ text: sentence(r.summary), cite: r.id })) : undefined,
  }));
  return { facts, rows };
}

function coveredClause(rows: CoveredRow[]): ShareClause | null {
  // Two costs keep the card's one sentence short enough to read at a glance.
  const pick = rows.filter((r) => r.expense !== "other" && r.covered.length).slice(0, 2);
  if (!pick.length) return null;
  return {
    id: "covered",
    text: `you can ask to be paid back for costs like ${joinWords(pick.map((r) => r.label.toLowerCase()))}`,
    cites: pick.flatMap((r) => r.covered.map((x) => x.id)),
  };
}

function examSection(c: Corpus): { facts: Fact[]; key: KeyFact | null; clause: ShareClause | null } {
  const noBill = c.of("exam_no_bill");
  const payment = c.of("exam_payment").filter((r) => !c.setAside(r));
  const coveredExam = c.of("covered_expense").filter((r) => expenseOf(r) === "forensic_exam" && !c.setAside(r));
  const facts: Fact[] = [];
  let key: KeyFact | null = null;
  let clause: ShareClause | null = null;

  if (noBill.length) {
    const cites = noBill.map((r) => r.id);
    facts.push({
      key: "exam-no-bill",
      text: "You should not get a bill for a sexual assault forensic exam.",
      cites,
      kind: "law",
    });
    key = { id: "exam", big: money(0), small: "what a forensic exam should cost you", cites };
    clause = { id: "exam", text: "you should never get a bill for a forensic exam", cites };

    const by = (v: string) => noBill.filter((r) => params(r).insurance_billing === v).map((r) => r.id);
    const insurance: [string, string][] = [
      ["prohibited", "The provider should not bill your insurance for it either."],
      ["consent_required", "The provider can bill your insurance for it only if you agree."],
      ["allowed", "The provider may bill your insurance, but not you."],
    ];
    for (const [value, text] of insurance) {
      const ids = by(value);
      if (ids.length) {
        facts.push({ key: `exam-insurance-${value}`, text, cites: ids, kind: "law" });
        break;
      }
    }
  }
  facts.push(...summaryFacts(payment, "exam-payment"), ...summaryFacts(coveredExam, "exam-covered"));
  return { facts, key, clause };
}

function reportSection(c: Corpus): { facts: Fact[]; key: KeyFact | null; clause: ShareClause | null } {
  const rules = c.of("reporting_requirement").filter((r) => !c.setAside(r));
  if (!rules.length) return { facts: [], key: null, clause: null };
  const required = rules.filter((r) => params(r).required === true);
  // An exam counts with confidence only where the law that sets the requirement names it.
  const examInRequired = required.filter((r) => list(r, "alternatives").includes("forensic_exam"));
  const facts = summaryFacts(rules, "report");
  let key: KeyFact;
  let clause: ShareClause | null = null;

  if (!required.length) {
    const others = rules.some((r) => list(r, "alternatives").length);
    key = {
      id: "report",
      big: "Police report",
      small: others ? "not required; other records can count" : "not required to apply",
      cites: rules.map((r) => r.id),
    };
  } else if (examInRequired.length) {
    const cites = examInRequired.map((r) => r.id);
    key = { id: "report", big: "Exam can count", small: "in place of a police report", cites };
    clause = { id: "report", text: "a forensic exam can count instead of a police report", cites };
  } else {
    const within = required
      .map((r) => {
        const d = num(r, "within_days");
        const h = num(r, "within_hours");
        return h ? { text: plural(h, ["hour", "hours"]), r } : d ? { text: plural(d, ["day", "days"]), r } : null;
      })
      .filter((x): x is { text: string; r: Rule } => x !== null);
    key = {
      id: "report",
      big: "Police report",
      small: within.length ? `the program asks for one within ${within[0].text}` : "the program asks for one",
      cites: within.length ? [within[0].r.id] : required.map((r) => r.id),
    };
  }

  // One plain line before the rules themselves, from params only. Two examples at most keep it
  // short; the rules below list every one.
  const alts = ALTERNATIVE_ORDER.filter((a) => rules.some((r) => list(r, "alternatives").includes(a)));
  const altRules = rules.filter((r) => list(r, "alternatives").some((a) => alts.includes(a)));
  const like = joinWords(
    alts.slice(0, 2).map((a) => ALTERNATIVE_PHRASE[a]),
    "or",
  );
  let lead: Fact | null = null;
  if (!required.length) {
    lead = {
      key: "report-lead",
      text: alts.length
        ? `A police report is not required. Other records can count, like ${like}.`
        : "A police report is not required.",
      cites: rules.map((r) => r.id),
      kind: "law",
    };
  } else if (alts.length) {
    lead = {
      key: "report-lead",
      text: `The program asks for a police report. The rules below say when other records can count instead, like ${like}.`,
      cites: [...new Set([...required, ...altRules].map((r) => r.id))],
      kind: "law",
    };
  } else {
    lead = {
      key: "report-lead",
      text: "The program asks that the crime be reported to police.",
      cites: required.map((r) => r.id),
      kind: "law",
    };
  }
  return { facts: [lead, ...facts], key, clause };
}

function deadlineSection(c: Corpus): { facts: Fact[]; key: KeyFact | null; clause: ShareClause | null } {
  const rules = c.of("filing_deadline").filter((r) => !c.setAside(r));
  const timed = rules
    .map((r) => ({ r, d: duration(r), from: String(params(r).from ?? "") }))
    .filter((x) => x.d !== null);
  // The headline deadline counts from the day it happened. Where rules differ, the shortest one
  // leads: a reader who files early loses nothing, and one told the longest window could miss the
  // real one (Florida: 3 years, or 5 with good cause). The longer windows follow as their own rules.
  // The engine's eligibility check uses the longest instead (docs/SPEC.md step 10), so it never
  // turns someone away; the two answer different questions.
  const primary = timed
    .filter((x) => FROM_INCIDENT.has(x.from))
    .sort((a, b) => a.d!.days - b.d!.days || a.r.id.localeCompare(b.r.id))[0];
  const facts: Fact[] = [];
  let key: KeyFact | null = null;
  let clause: ShareClause | null = null;
  if (primary) {
    const cites = [primary.r.id];
    facts.push({
      key: "deadline",
      text: `Apply within ${primary.d!.text} of the date it happened.`,
      cites,
      kind: "law",
    });
    key = { id: "deadline", big: primary.d!.text, small: "to apply, from the date it happened", cites };
    clause = { id: "deadline", text: `you have ${primary.d!.text} to apply`, cites };
  }
  facts.push(
    ...summaryFacts(
      rules.filter((r) => r !== primary?.r),
      "deadline",
    ),
  );
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
    }))
    .filter((x) => METHOD_LABEL[x.method] && x.target)
    .sort((a, b) => METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method));
  for (const { r, method, target } of submissions) {
    let href: string | undefined;
    if (method === "online" && /^https?:\/\//i.test(target)) href = target;
    if (method === "email" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) href = `mailto:${target}`;
    facts.push({ key: `apply-${r.id}`, label: METHOD_LABEL[method], text: target, cites: [r.id], kind: "law", href });
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

export function buildStateSummary(law: Jurisdiction, ir: IrSummary | null): StateSummary {
  const c = new Corpus(law, ir);
  const st = law.jurisdiction;
  const place = placeName(st, law.name);

  const total = totalSection(c);
  const covered = coveredSection(c);
  const exam = examSection(c);
  const report = reportSection(c);
  const deadline = deadlineSection(c);
  const contact = contactFacts(law, c);
  const excluded = c.of("excluded_expense").filter((r) => !c.setAside(r));
  const privacy = [...c.of("address_confidentiality"), ...c.of("record_confidentiality")];
  const urgent = c.of("emergency_award").filter((r) => !c.setAside(r));
  const before = [
    ...c.of("residency"),
    ...c.of("collateral_source"),
    ...c.of("minimum_loss").filter((r) => !c.setAside(r)),
  ];

  // Tend's own notes say what it could not verify. They carry no citation and are styled apart.
  const note = (key: string, text: string): Fact[] => [{ key, text, cites: [], kind: "note" }];
  const all: Section[] = [
    { id: "costs", title: "What the program can pay for", nav: "Costs", facts: [...total.facts, ...covered.facts] },
    {
      id: "not-covered",
      title: "What it does not pay for",
      nav: "Not covered",
      facts: summaryFacts(excluded, "excluded"),
    },
    { id: "exam", title: "The forensic exam", nav: "Exam", facts: exam.facts },
    { id: "police", title: "Police report", nav: "Police report", facts: report.facts },
    {
      id: "deadline",
      title: "Deadline to apply",
      nav: "Deadline",
      facts: deadline.facts.length
        ? deadline.facts
        : note(
            "deadline-none",
            `Tend has not verified a filing deadline for ${law.name}. Ask the program before you wait.`,
          ),
    },
    {
      id: "privacy",
      title: "Keeping your name and address private",
      nav: "Privacy",
      facts: privacy.length
        ? summaryFacts(privacy, "privacy")
        : note("privacy-none", `Tend has not verified an address or records privacy law for ${law.name} yet.`),
    },
    { id: "apply", title: "How to apply", nav: "How to apply", facts: contact.facts },
    { id: "urgent", title: "If you need money soon", nav: "Urgent money", facts: summaryFacts(urgent, "urgent") },
    {
      id: "before",
      title: "Good to know before you apply",
      nav: "Good to know",
      facts: summaryFacts(before, "before"),
    },
  ];
  const sections = all.filter((s) => s.facts.length);

  const keyFacts = [total.key, deadline.key, report.key, exam.key].filter((k): k is KeyFact => k !== null);

  // "If you're Jane Doe in Michigan: <money>, and <one protection>."
  const first = total.clause ?? coveredClause(covered.rows);
  const second = report.clause ?? exam.clause ?? deadline.clause;
  const clauses = [first, second].filter((x): x is ShareClause => x !== null);
  const text = `If you're Jane Doe in ${place}: ${clauses.map((x) => x.text).join(", and ")}.`;

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

// Every rule or source id a summary cites, for the law page links and for tests.
export function citedIds(summary: StateSummary): Set<string> {
  const ids = new Set<string>();
  for (const s of summary.sections) for (const f of s.facts) f.cites.forEach((id) => ids.add(id));
  for (const k of summary.keyFacts) k.cites.forEach((id) => ids.add(id));
  for (const c of summary.share.clauses) c.cites.forEach((id) => ids.add(id));
  return ids;
}
