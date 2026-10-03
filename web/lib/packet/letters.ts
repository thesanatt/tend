// Letters the survivor can send, written in their voice with the law quoted. Names, dates, and
// account numbers stay as [placeholders]: Tend never knows them and never fills them in.
import type { Letter, LetterKind } from "../contracts";
import { formatDay } from "../dates";
import { formatCents } from "../money";
import type { EngineInput, EngineItem, EngineLine, EngineOutput, Expense, Rule } from "../types";
import { docScope, scopeApplies } from "./checklist";
import { param, type LawBook } from "./law";

export const LETTER_KINDS: LetterKind[] = [
  "billing_hold",
  "employer_wages",
  "provider_statement",
  "itemized_bill_request",
];

export function programPhrase(law: LawBook): string {
  const name = law.law.program.program_name?.trim() || "crime victim compensation";
  return `the ${name}${/program$/i.test(name) ? "" : " program"} in ${law.name}`;
}

const cite = (r: Rule) => `"${r.quote.trim()}" (${r.pinpoint})`;

function claimed(output: EngineOutput): EngineLine[] {
  return output.lines.filter((l) => l.status === "eligible" || l.status === "needs_confirmation");
}

function itemLine(item: EngineItem | undefined, line: EngineLine): string {
  const what = item?.description?.trim() || "Charge";
  const when = item?.date ? `, ${formatDay(item.date)}` : "";
  return `    ${what}${when}: ${formatCents(line.requested_cents)}`;
}

function letter(kind: LetterKind, title: string, paragraphs: (string | null | false)[], rules: Rule[]): Letter {
  const ids: string[] = [];
  for (const r of rules) if (!ids.includes(r.id)) ids.push(r.id);
  return {
    kind,
    title,
    body: paragraphs.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n\n") + "\n",
    rule_ids: ids,
  };
}

const SIGN_OFF = "Thank you,\n[Your name]\n[A safe way to reach you]";

// The state's own words asking for this document: a rule of one of these types, or one whose
// scope is exactly this kind of cost ("Mental health provider contact information").
function documentRules(
  law: LawBook,
  input: EngineInput,
  output: EngineOutput,
  types: string[],
  expense: Expense,
): Rule[] {
  const rules = law.byCategory("required_document").filter((r) => {
    if (types.includes(String(param(r, "document")))) return true;
    const scope = docScope(r);
    return scope.kind === "expenses" && scope.expenses.length === 1 && scope.expenses[0] === expense;
  });
  const fitting = rules.filter((r) => scopeApplies(docScope(r), input, output));
  return (fitting.length ? fitting : rules).slice(0, 1);
}

// One letter per bill: lines from the same itemized bill share the part of the id before the last ":".
export function billKey(itemId: string): string {
  const cut = itemId.lastIndexOf(":");
  // "exam-1" and "exam-2" have no bill part: each is its own bill.
  return itemId.startsWith("nessie:") || cut <= 0 ? itemId : itemId.slice(0, cut);
}

export function billingHold(law: LawBook, held: EngineLine[], items: Map<string, EngineItem>): Letter | null {
  const ids = new Set(held.flatMap((l) => l.rule_ids));
  const pick = (rules: Rule[]) => {
    const cited = rules.filter((r) => ids.has(r.id));
    return cited.length ? cited : rules;
  };
  // The main no-bill rule; the summary quotes the rest.
  const why = pick(law.byCategory("exam_no_bill")).slice(0, 1);
  const payers = pick(law.byCategory("exam_payment")).slice(0, 1);
  // Without a no-bill rule, a held exam rests on the rule that names who pays for it.
  if (!why.length && !(held.length && payers.length)) return null;
  const charges = held.length
    ? held.map((l) => itemLine(items.get(l.item_id), l)).join("\n")
    : "    [Exam charge, date of service]: [amount]";
  return letter(
    "billing_hold",
    "Letter to the billing office: remove the exam charge",
    [
      "[Date]",
      "To: Billing office, [hospital or clinic name]\nAbout: Account [account number]",
      `I am writing about ${held.length > 1 ? "these charges" : "this charge"} on my account for a sexual assault forensic exam:\n\n${charges}`,
      why.length
        ? `${law.name} law says I should not be billed for this exam:\n\n${why.map(cite).join("\n\n")}`
        : `${law.name} law says this about paying for the exam:\n\n${payers.map(cite).join("\n\n")}`,
      why.length
        ? "Please remove the exam charge from my account, stop any collection on it, and send me an updated statement."
        : "Please put this charge on hold while the exam is paid for the way the law describes, and send me an updated statement.",
      why.length && payers.length
        ? `The law names who pays for the exam instead:\n\n${payers.map(cite).join("\n\n")}`
        : null,
      "If you have questions, please contact me in writing.",
      SIGN_OFF,
    ],
    [...why, ...payers],
  );
}

export function employerWages(law: LawBook, input: EngineInput, output: EngineOutput): Letter {
  const covered = law.byCategory("covered_expense").filter((r) => (r.expense ?? param(r, "expense")) === "lost_wages");
  const asks = documentRules(law, input, output, ["wage_verification"], "lost_wages");
  return letter(
    "employer_wages",
    "Letter to your employer: pay and time missed",
    [
      "[Date]",
      "To: [Employer name], payroll or human resources",
      `I am applying to ${programPhrase(law)} for pay I lost while I was out of work. The program asks for a statement from my employer.`,
      [
        "Please write a short statement on company letterhead that lists:",
        "- the days I missed, from [first day] to [last day]",
        "- my usual pay (hourly rate or weekly pay) and my usual hours each week",
        "- any sick leave, vacation, or other paid time I used for those days",
        "- the name and phone number of someone who can confirm this",
      ].join("\n"),
      "You do not need to know why I was out, and I am not asking you to share anything else about me.",
      asks.length ? `The program's own checklist says:\n\n${asks.map(cite).join("\n\n")}` : null,
      covered.length ? `The law covers lost pay:\n\n${cite(covered[0])}` : null,
      "Please give the statement to me, not to the program, so I can send it with my claim.",
      "Thank you,\n[Your name]\n[Your job title or employee number]",
    ],
    [...asks, ...covered.slice(0, 1)],
  );
}

export function providerStatement(law: LawBook, input: EngineInput, output: EngineOutput): Letter {
  const asks = documentRules(law, input, output, ["counseling_statement"], "counseling");
  const caps = law
    .byCategory("expense_cap")
    .filter((r) => (r.expense ?? param(r, "expense")) === "counseling")
    .slice(0, 1);
  return letter(
    "provider_statement",
    "Letter to your counselor: dates and costs of sessions",
    [
      "[Date]",
      "To: [Counselor or clinic name]",
      `I am applying to ${programPhrase(law)} for help with the cost of my sessions. The program asks for a statement from my provider.`,
      [
        "Please write a statement that lists:",
        "- the date of each session",
        "- the type of service, for example an individual counseling session",
        "- the amount charged for each session, what insurance paid, and what I paid",
        "- your license type and number, and how the program can reach you",
      ].join("\n"),
      "Please do not include session notes. The program only needs dates and costs.",
      asks.length ? `The program's own checklist says:\n\n${asks.map(cite).join("\n\n")}` : null,
      caps.length ? `The law sets this limit for counseling:\n\n${cite(caps[0])}` : null,
      SIGN_OFF,
    ],
    [...asks, ...caps],
  );
}

export function itemizedBillRequest(
  law: LawBook,
  input: EngineInput,
  output: EngineOutput,
  lines: EngineLine[],
  items: Map<string, EngineItem>,
): Letter {
  const asks = documentRules(law, input, output, ["itemized_bill"], "medical");
  const charges = lines.length
    ? lines.map((l) => itemLine(items.get(l.item_id), l)).join("\n")
    : "    [Charge, date of service]: [amount]";
  return letter(
    "itemized_bill_request",
    "Letter to a billing office: ask for an itemized bill",
    [
      "[Date]",
      "To: Billing office, [provider name]\nAbout: Account [account number]",
      `Please send me an itemized bill for ${lines.length > 1 ? "these charges" : "this charge"}:\n\n${charges}`,
      "An itemized bill lists each service with its date, its billing code, and its charge, plus any insurance payments or adjustments.",
      `I need it for my claim to ${programPhrase(law)}.${asks.length ? ` The program asks for itemized bills:\n\n${asks.map(cite).join("\n\n")}` : ""}`,
      SIGN_OFF,
    ],
    asks,
  );
}

// The letters this claim calls for, in a fixed order. With all: true, every kind the state's
// rules support, with [placeholders] where the claim has no lines for it.
export function buildLetters(
  law: LawBook,
  input: EngineInput,
  output: EngineOutput,
  opts: { all?: boolean } = {},
): Letter[] {
  const items = new Map(input.items.map((i) => [i.item_id, i]));
  const open = claimed(output);
  const out: Letter[] = [];

  const held = output.lines.filter((l) => l.status === "held");
  const bills = new Map<string, EngineLine[]>();
  for (const l of held) bills.set(billKey(l.item_id), [...(bills.get(billKey(l.item_id)) ?? []), l]);
  for (const group of bills.values()) {
    const l = billingHold(law, group, items);
    if (l) out.push(l);
  }
  if (!held.length && opts.all) {
    const l = billingHold(law, [], items);
    if (l) out.push(l);
  }

  if (opts.all || open.some((l) => l.expense === "lost_wages")) out.push(employerWages(law, input, output));
  if (opts.all || open.some((l) => l.expense === "counseling")) out.push(providerStatement(law, input, output));

  // Care paid at the counter or seen only as a bank charge has no itemized bill yet.
  const unitemized = open.filter((l) => {
    const item = items.get(l.item_id);
    return (
      (l.expense === "medical" || l.expense === "dental") &&
      (!item || item.item_id.startsWith("nessie:") || !item.is_bill)
    );
  });
  if (opts.all || unitemized.length) out.push(itemizedBillRequest(law, input, output, unitemized, items));
  return out;
}
