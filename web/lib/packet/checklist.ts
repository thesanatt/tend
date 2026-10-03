// "Still needed": the state's required_document rules that fit the costs in this claim. Each item
// keeps its rule id and verbatim quote. Which rules fit is decided by fixed keyword tables over the
// rule's note, pinpoint, and quote, so the same claim always gets the same list.
import type { ChecklistItem } from "../contracts";
import type { EngineInput, EngineOutput, Expense, Rule } from "../types";
import { param, type LawBook } from "./law";

export type DocScope =
  | { kind: "always" }
  | { kind: "expenses"; expenses: Expense[] }
  | { kind: "report" } // a police report: needed when one was made or no alternative applies
  | { kind: "exam" } // exam paperwork: needed when there was an exam
  | { kind: "late" } // a reason for filing late: only past the deadline
  | { kind: "skip"; why: string };

const CARE: Expense[] = ["medical", "forensic_exam", "dental", "prescription", "counseling"];

// Checked first, on what the document is: the first clause of the researcher's note (or of the
// quote when there is no note), so "signed application; a parent signs for a minor" stays a
// signed application. These name situations Tend's users (adult survivors filing for
// themselves) are rarely in, or conditions Tend can check.
const DEATH = "for a claim after a death";
const SPECIAL: [RegExp, DocScope][] = [
  [
    /\b(death|deceased|died|loss of support|survivor'?s benefits?|dependents?|child support|marriage certificate)\b/i,
    { kind: "skip", why: DEATH },
  ],
  [
    /\b(guardianship|child victim|for a minor|applies for a minor|power of attorney|incapacitated|under (age )?1[89]|parent or (legal )?guardian)\b/i,
    { kind: "skip", why: "for someone filing on another person's behalf" },
  ],
  [/\b(letter of appearance|attorney represents|attorney must file)\b/i, { kind: "skip", why: "only with a lawyer" }],
  [/\bemergency award\b/i, { kind: "skip", why: "only when asking for an emergency award" }],
  [
    /\b(SANE|exam bill|forensic exam\w*|sexual assault (medical |forensic )*(exam|examination)|sexual assault billing form)\b/i,
    { kind: "exam" },
  ],
];
// Filing late (not reporting late, which Tend cannot know): only past the deadline.
const LATE =
  /\b(fil(e|ed|ing)|appl(y|ying|ication))\b[^.;]*\b(late|delay(ed)?|more than)\b|\b(late|delay(ed)?)\b[^.;]*\b(fil(e|ed|ing)|appl(y|ying|ication))\b/i;

// Which kinds of cost a document belongs to, by the words used to describe it.
const HINTS: [RegExp, Expense[]][] = [
  [/\b(funeral|burial|cemetery)\b/i, ["funeral"]],
  [/\b(relocat\w*|moving|movers?|lease|lodging|utilit(y|ies))\b/i, ["relocation", "temporary_housing"]],
  [/\b(security|locks?|alarms?|landlord'?s?)\b/i, ["security"]],
  [/\b(clean-?up|crime scene)\b/i, ["crime_scene_cleanup"]],
  [
    /\b(held as evidence|evidence receipt|clothing|bedding|replacement costs?)\b/i,
    ["clothing_bedding", "property_replacement"],
  ],
  [/\b(mileage|travel|transportation)\b/i, ["transportation"]],
  [
    /\b(wages?|earnings?|pay ?stubs?|employer|employment|work|disability|W-2|schedule c|income tax|sick|vacation|unemployment)\b/i,
    ["lost_wages"],
  ],
  [/\b(prescriptions?|medications?|pharmacy|glasses|medical equipment)\b/i, ["prescription", "medical"]],
  [/\b(dental|dentist|dentures?)\b/i, ["dental"]],
  [/\b(counsel\w*|mental health|therap\w*|psycholog\w*)\b/i, ["counseling"]],
  [/\b(child ?care|day ?care)\b/i, ["childcare"]],
  [/\b(medical|hospital|HIPAA|health care|physician|doctor|treatment|clinic)\b/i, CARE],
];

const BY_TYPE: Record<string, DocScope> = {
  photo_id: { kind: "always" },
  proof_of_residency: { kind: "always" },
  police_report: { kind: "report" },
  exam_record: { kind: "exam" },
  itemized_bill: { kind: "always" },
  receipts: { kind: "always" },
  wage_verification: { kind: "expenses", expenses: ["lost_wages"] },
  medical_records: { kind: "expenses", expenses: CARE },
  counseling_statement: { kind: "expenses", expenses: ["counseling"] },
  insurance_statement: { kind: "expenses", expenses: CARE },
  other: { kind: "always" },
};

const LABEL: Record<string, string> = {
  photo_id: "A copy of your photo ID",
  proof_of_residency: "Proof of where you live",
  police_report: "The police report, or its number",
  exam_record: "A record of your forensic exam",
  itemized_bill: "Itemized bills",
  receipts: "Receipts for costs you paid",
  wage_verification: "Proof of the pay you missed",
  medical_records: "Medical records",
  counseling_statement: "A statement from your counselor",
  insurance_statement: "Insurance statements (explanation of benefits)",
  other: "A document the program asks for",
};

function hinted(text: string): Set<Expense> {
  // A Social Security number is not home security.
  const t = text.replace(/social security/gi, "");
  const out = new Set<Expense>();
  for (const [re, expenses] of HINTS) if (re.test(t)) expenses.forEach((e) => out.add(e));
  return out;
}

// "For lost wages: ...", "... (only if claiming lost wages)", "... for medical, dental, ...":
// a clause that says what the document is for outranks the rest of the note.
const LEAD = /^([^:]{2,60}):/;
const CLAUSE = /\b(?:only\s+)?(?:if|when|for)\s+([^.;:()]+)/gi;

function noteScope(note: string): Set<Expense> {
  const clauses = [LEAD.exec(note)?.[1] ?? "", ...[...note.matchAll(CLAUSE)].map((m) => m[1])];
  const scoped = new Set<Expense>();
  for (const c of clauses) hinted(c).forEach((e) => scoped.add(e));
  return scoped.size ? scoped : hinted(note);
}

export function docScope(rule: Rule): DocScope {
  const type = String(param(rule, "document") ?? "other");
  if (type === "police_report" || type === "exam_record" || type === "photo_id" || type === "proof_of_residency") {
    return BY_TYPE[type];
  }
  const note = String(param(rule, "note") ?? "").trim();
  const about = note || rule.quote;
  const first = about.split(/[;(]/)[0];
  // "Loss of support: tax returns and W-2s" is about loss of support, whatever follows the colon.
  const subject = LEAD.exec(about)?.[1] ?? first;
  for (const [re, scope] of SPECIAL) {
    if (!re.test(scope.kind === "skip" ? subject : first)) continue;
    // "for lost wages or loss of support" still serves lost wages.
    if (scope.kind === "skip" && scope.why === DEATH && [...hinted(subject)].some((e) => e !== "funeral")) continue;
    return scope;
  }
  if (LATE.test(about)) return { kind: "late" };
  if (type === "wage_verification" || type === "counseling_statement") return BY_TYPE[type];
  // The note describes this document; the pinpoint often names a checklist section that lists
  // several kinds of cost. Where both speak, keep what they agree on.
  const fromNote = noteScope(note);
  const fromPinpoint = hinted(rule.pinpoint);
  let expenses = fromNote.size ? fromNote : fromPinpoint;
  if (fromNote.size && fromPinpoint.size) {
    const both = [...fromNote].filter((e) => fromPinpoint.has(e));
    if (both.length) expenses = new Set(both);
  }
  if (expenses.size) return { kind: "expenses", expenses: [...expenses] };
  return BY_TYPE[type] ?? BY_TYPE.other;
}

// Kinds of cost the survivor is asking for (counted, or waiting for a yes).
export function claimedExpenses(output: EngineOutput): Set<string> {
  return new Set(
    output.lines.filter((l) => l.status === "eligible" || l.status === "needs_confirmation").map((l) => l.expense),
  );
}

export function scopeApplies(scope: DocScope, input: EngineInput, output: EngineOutput): boolean {
  switch (scope.kind) {
    case "always":
      return true;
    case "expenses": {
      const claimed = claimedExpenses(output);
      return scope.expenses.some((e) => claimed.has(e));
    }
    case "report": {
      const status = output.checks.reporting.status;
      if (input.context.police_report === "yes") return true;
      return status === "required" || status === "unknown";
    }
    case "exam":
      return input.context.forensic_exam || output.lines.some((l) => l.status === "held");
    case "late":
      return output.checks.deadline.status === "late";
    case "skip":
      return false;
  }
}

// Itemized bills are on hand when every cost the document covers came from a bill Tend read line
// by line (those carry the bill's own ids, not a bank record's).
function itemizedOnHand(scope: DocScope, input: EngineInput, output: EngineOutput): boolean {
  const items = new Map(input.items.map((i) => [i.item_id, i]));
  const covered = output.lines.filter(
    (l) =>
      (l.status === "eligible" || l.status === "needs_confirmation") &&
      (scope.kind !== "expenses" || scope.expenses.includes(l.expense as Expense)),
  );
  return (
    covered.length > 0 &&
    covered.every((l) => {
      const item = items.get(l.item_id);
      return !!item && item.is_bill && !item.item_id.startsWith("nessie:");
    })
  );
}

function sentence(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

export function stillNeeded(
  law: LawBook,
  input: EngineInput,
  output: EngineOutput,
  have: Record<string, boolean> = {},
): ChecklistItem[] {
  return law
    .byCategory("required_document")
    .map((r) => ({ r, scope: docScope(r) }))
    .filter(({ scope }) => scopeApplies(scope, input, output))
    .map(({ r, scope }) => {
      const type = String(param(r, "document") ?? "other");
      const note = param<string>(r, "note");
      const known = have[r.id] ?? have[type];
      return {
        document: sentence(typeof note === "string" && note.trim() ? note : (LABEL[type] ?? LABEL.other)),
        rule_id: r.id,
        quote: r.quote,
        have_it: known ?? (type === "itemized_bill" && itemizedOnHand(scope, input, output)),
      };
    });
}
