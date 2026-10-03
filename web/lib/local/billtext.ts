// Port of api/tend_api/bill.py's text parser: itemized lines, totals, amount due, adjustments, and
// the expense each line names. The server and the device read the same PDF the same way, and a
// line's id is the same "bill:<sha256 prefix>:<line>" the server gives it.
import { MONEY_TOKEN_SOURCE, isoDay, parseCents } from "./amounts";
import { pyRegex, pyStrip, pyStripChars } from "./pytext";

const ROW_START = pyRegex(
  String.raw`^\s*(?:\d{1,3}\s+)?(?:(?<y>\d{4})-(?<m>\d{2})-(?<d>\d{2})|(?<m2>\d{1,2})/(?<d2>\d{1,2})/(?<y2>\d{2,4}))\b`,
  "i",
);
const MONEY_TOKEN = pyRegex(MONEY_TOKEN_SOURCE, "g");
const TRAILING_AMOUNT = pyRegex(`(?:${MONEY_TOKEN_SOURCE})\\s*$`, "");
const META = pyRegex(
  String.raw`(?:^|\s{2,})(?<key>provider|facility|statement date|bill id|account number|account)\s*[:#]\s*(?<value>\S.*?)\s*$`,
  "i",
);
const FICTIONAL = pyRegex(String.raw`\bfictional\b|\bnot a real\b`, "i");
const BANNER = pyRegex(String.raw`^\W*fictional demo|\bnot a real\b`, "i");
const DUE = pyRegex("amount due|balance due|total due|you owe|patient responsibility|please pay", "i");
const TOTAL = pyRegex(String.raw`\btotals?\b`, "i");
const ADJUSTMENT = pyRegex("insurance|payment|paid|adjust|discount|credit|write.?off", "i");
const TWO_SPACES = pyRegex(String.raw`\s{2,}`, "g");
// The line breaks str.splitlines() honors.
const SPLITLINES = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

// First match wins. Hospital pharmacy and supply charges are medical care on a hospital bill.
export const EXPENSE_PATTERNS: [string, RegExp][] = [
  [
    "forensic_exam",
    pyRegex(String.raw`forensic|sexual assault (?:medical )?exam|\bSANE\b|\bSAFE\b exam|evidence (?:collection|kit)|rape kit`, "i"),
  ],
  ["counseling", pyRegex("counsel|therap|psych|behavioral health", "i")],
  ["dental", pyRegex(String.raw`dental|dentist|\btooth\b|\bteeth\b`, "i")],
  [
    "medical",
    pyRegex(
      String.raw`emergency|\bE[DR]\b|visit|physician|laborator|\blab\b|labs\b|x-?ray|imaging|radiolog|\bCT\b|\bMRI\b|urgent care|triage` +
        String.raw`|facility|clinic|nurs|exam|treatment|injection|suppl|ambulance|pharmacy|medication|prophyla|\bsuture`,
      "i",
    ),
  ],
];

export function matchExpense(description: string): { expense: string; match: string | null } {
  for (const [expense, pattern] of EXPENSE_PATTERNS) {
    const m = pattern.exec(description);
    if (m) return { expense, match: m[0] };
  }
  return { expense: "unknown", match: null };
}

export interface TextBillLine {
  line_no: number;
  date: string;
  description: string;
  amount_cents: number; // what the patient owes on this line: the last money column
  columns_cents: number[];
}

export interface TextBill {
  lines: TextBillLine[];
  provider: string | null;
  statement_date: string | null;
  bill_id: string | null;
  account_ref: string | null;
  fictional: boolean;
  total_cents: number | null;
  amount_due_cents: number | null;
  adjustments: { label: string; amount_cents: number }[];
}

export class BillReadError extends Error {}

function rowDate(m: RegExpExecArray): string {
  const g = m.groups!;
  let iso: string | null;
  if (g.y) iso = isoDay(Number(g.y), Number(g.m), Number(g.d));
  else {
    const year = Number(g.y2);
    iso = isoDay(year < 100 ? year + 2000 : year, Number(g.m2), Number(g.d2));
  }
  if (!iso) throw new BillReadError(`bad date on bill line: ${m.input}`);
  return iso;
}

function cents(token: string, line: string): number {
  try {
    return parseCents(token);
  } catch {
    throw new BillReadError(`Tend could not read the amount ${pyStrip(token)} on this bill line: ${line}`);
  }
}

export function parseTextBill(text: string): TextBill {
  const bill: TextBill = {
    lines: [],
    provider: null,
    statement_date: null,
    bill_id: null,
    account_ref: null,
    fictional: false,
    total_cents: null,
    amount_due_cents: null,
    adjustments: [],
  };
  let title: string | null = null;
  const totals: number[] = [];
  const dues: number[] = [];
  for (const raw of text.split(SPLITLINES)) {
    const line = pyStrip(raw);
    if (!line) continue;
    if (FICTIONAL.test(line)) bill.fictional = true;
    const amounts = TRAILING_AMOUNT.test(line) ? [...line.matchAll(MONEY_TOKEN)] : [];
    if (!amounts.length) {
      const meta = META.exec(line);
      if (meta) {
        const key = meta.groups!.key.toLowerCase();
        const value = meta.groups!.value;
        if (key === "provider" || key === "facility") bill.provider = value;
        else if (key === "statement date") bill.statement_date = value;
        else if (key === "bill id") bill.bill_id = value;
        else bill.account_ref = value;
      } else if (title === null && !BANNER.test(line)) {
        title = line.split(TWO_SPACES)[0];
      }
      continue;
    }
    const first = amounts[0].index!;
    const row = ROW_START.exec(line);
    if (row && first > row.index + row[0].length) {
      const when = rowDate(row);
      const description = pyStripChars(line.slice(row.index + row[0].length, first).replace(TWO_SPACES, " "), " .\t-");
      const columns = amounts.map((a) => cents(a[0], line));
      const owed = columns[columns.length - 1];
      if (owed < 0) {
        // A dated credit, such as a payment received, reduces what is due.
        bill.adjustments.push({ label: description, amount_cents: -owed });
        continue;
      }
      bill.lines.push({ line_no: bill.lines.length + 1, date: when, description, amount_cents: owed, columns_cents: columns });
      continue;
    }
    const label = pyStripChars(line.slice(0, first), " .:\t");
    const value = cents(amounts[amounts.length - 1][0], line);
    if (DUE.test(label)) dues.push(value);
    else if (TOTAL.test(label)) totals.push(value);
    else if (ADJUSTMENT.test(label)) bill.adjustments.push({ label, amount_cents: Math.abs(value) });
  }
  bill.provider = bill.provider || title;
  bill.total_cents = totals.length ? totals[totals.length - 1] : null;
  bill.amount_due_cents = dues.length ? dues[dues.length - 1] : null;
  return bill;
}

export interface BalanceCheck {
  name: string;
  ok: boolean;
}

// The lines must add up to the bill's own total (bill.py balance_checks).
export function balanceChecks(bill: TextBill): BalanceCheck[] {
  const linesSum = bill.lines.reduce((s, l) => s + l.amount_cents, 0);
  const adjustments = bill.adjustments.reduce((s, a) => s + a.amount_cents, 0);
  const checks: BalanceCheck[] = [];
  if (bill.total_cents !== null) {
    checks.push({ name: "lines_equal_total", ok: linesSum === bill.total_cents });
    if (bill.amount_due_cents !== null)
      checks.push({ name: "total_less_adjustments_equals_due", ok: bill.total_cents - adjustments === bill.amount_due_cents });
  } else if (bill.amount_due_cents !== null) {
    checks.push({ name: "lines_less_adjustments_equal_due", ok: linesSum - adjustments === bill.amount_due_cents });
  } else {
    checks.push({ name: "has_total", ok: false });
  }
  return checks;
}

