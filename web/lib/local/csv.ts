// Bank CSV exports: column sniffing for Capital One, Chase, Bank of America, Wells Fargo, Citi,
// American Express, and generic date / description / amount or debit / credit files.
// Money out is positive, money in is negative, all in integer cents.
import { detectDateOrder, parseAmount, parseDate, type DateOrder, type ParsedAmount } from "./amounts";
import { fnv64 } from "./hash";
import type { LocalTxn, StatementResult, TxnKind } from "./types";

interface Row {
  cells: string[];
  line: number; // physical line where the record starts, 1-based
}

// RFC 4180: quoted fields, "" escapes, delimiters and newlines inside quotes, CRLF or LF.
export function readRows(text: string, delimiter: string): Row[] {
  const rows: Row[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === "\n") line++;
        cell += c;
      }
      continue;
    }
    if (c === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (c === delimiter) {
      cells.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      cells.push(cell);
      if (cells.some((x) => x.trim() !== "")) rows.push({ cells, line: start });
      cells = [];
      cell = "";
      line++;
      start = line;
    } else cell += c;
  }
  cells.push(cell);
  if (cells.some((x) => x.trim() !== "")) rows.push({ cells, line: start });
  return rows;
}

export function sniffDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 40).join("\n");
  let best = ",";
  let bestScore = -1;
  for (const d of [",", ";", "\t", "|"]) {
    const counts = readRows(sample, d).map((r) => r.cells.length);
    const multi = counts.filter((n) => n > 1);
    if (!multi.length) continue;
    const freq = new Map<number, number>();
    for (const n of multi) freq.set(n, (freq.get(n) ?? 0) + 1);
    const mode = Math.max(...freq.values());
    const score = multi.length + mode;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

export const normHeader = (h: string) =>
  h
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// For each role, header names from most to least preferred.
const ROLES = {
  date: [
    "transaction date",
    "trans date",
    "date",
    "transaction posted date",
    "posted date",
    "post date",
    "posting date",
    "date posted",
    "effective date",
    "value date",
    "booking date",
  ],
  description: [
    "description",
    "transaction description",
    "payee",
    "merchant name",
    "merchant",
    "name",
    "payee name",
    "original description",
    "transaction details",
    "narrative",
    "memo",
    "details",
  ],
  amount: ["amount", "transaction amount", "amount usd", "net amount"],
  debit: [
    "debit",
    "debits",
    "debit amount",
    "amount debit",
    "withdrawal",
    "withdrawals",
    "withdrawal amount",
    "money out",
    "paid out",
    "outflow",
    "charges",
    "charge",
    "spent",
  ],
  credit: [
    "credit",
    "credits",
    "credit amount",
    "amount credit",
    "deposit",
    "deposits",
    "deposit amount",
    "money in",
    "paid in",
    "inflow",
    "payments",
    "payment",
    "received",
  ],
  type: ["transaction type", "type", "debit credit", "debit or credit", "dr cr", "cr dr", "details"],
  category: ["category", "transaction category", "merchant category"],
  memo: ["memo", "extended details", "notes", "note"],
  reference: ["reference number", "transaction id", "reference", "ref"],
  status: ["status"],
  account: ["account number", "card no", "card number", "account"],
} as const;
type Role = keyof typeof ROLES;
type Columns = Partial<Record<Role, number>>;

function assignColumns(headers: string[]): Columns {
  const used = new Set<number>();
  const cols: Columns = {};
  // Order matters: a column can play one role, and description wins "details" before type does.
  for (const role of [
    "date",
    "amount",
    "debit",
    "credit",
    "description",
    "type",
    "category",
    "memo",
    "reference",
    "status",
    "account",
  ] as Role[]) {
    for (const name of ROLES[role]) {
      const i = headers.findIndex((h, idx) => h === name && !used.has(idx));
      if (i !== -1) {
        cols[role] = i;
        used.add(i);
        break;
      }
    }
  }
  return cols;
}

const has = (headers: string[], names: string[]) => names.every((n) => headers.includes(n));

function layoutFor(h: string[], cols: Columns): string {
  if (has(h, ["transaction date", "posted date", "card no", "description", "debit", "credit"]))
    return "capital_one_card";
  if (
    has(h, ["account number", "transaction description", "transaction date", "transaction type", "transaction amount"])
  )
    return "capital_one_360";
  if (has(h, ["transaction date", "post date", "description", "type", "amount"])) return "chase_card";
  if (has(h, ["details", "posting date", "description", "amount", "type"])) return "chase_checking";
  if (has(h, ["date", "description", "amount", "running bal"])) return "boa_checking";
  if (has(h, ["posted date", "reference number", "payee", "amount"])) return "boa_card";
  if (has(h, ["status", "date", "description", "debit", "credit"])) return "citi";
  if (
    has(h, ["date", "description", "amount"]) &&
    ["card member", "extended details", "appears on your statement as"].some((n) => h.includes(n))
  )
    return "amex";
  if (cols.debit !== undefined || cols.credit !== undefined) return "generic_debit_credit";
  return "generic_amount";
}

// Which way a signed amount column points: negative is money out everywhere except these exports.
const POSITIVE_IS_OUT = new Set(["amex"]);

const TYPE_OUT = /^(debit|dr|withdrawal|sale|purchase|fee|charge|check|atm|pos)$/i;
const TYPE_IN = /^(credit|cr|deposit|refund|return|payment|interest|dslip)$/i;
const INCOME_WORDS = /payroll|direct dep|salary|\bdeposit\b|refund|interest paid|payment thank you|thank you/i;
const BALANCE_LINE =
  /\b(beginning|ending|opening|closing|previous|new) balance\b|\btotal (credits|debits|deposits|withdrawals)\b/i;

// Money moved between the person's own accounts, or paid to their own card. A payment to a person
// or a business (Zelle, Venmo, autopay to a provider) stays a purchase so the rules can read it.
const OWN_TRANSFER =
  /\b(online|mobile|internal|funds|account|acct)\s+transfer\b|\b(transfer|xfer|withdrawal)\s+(to|from)\s+(\S+\s+){0,3}(sav|savings|chk|checking|share|acct|account|x+\d+|\*+\d+)\b|\bsave to\b|\bmove to (checking|savings)\b|\b(credit card|card|crcard|credit crd)\s*(autopay|payment|pmt)\b|\bpayment thank you\b/i;
const ATM = /\batm\b|\bcash withdrawal\b/i;

export function kindFor(description: string, cents: number): TxnKind {
  if (cents < 0) return "deposit";
  if (OWN_TRANSFER.test(description)) return "transfer";
  if (ATM.test(description)) return "withdrawal";
  return "purchase";
}

function clean(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

interface Draft {
  line: number;
  date: string;
  description: string;
  category?: string;
  status?: string;
  reference?: string;
  account?: string;
  amount: ParsedAmount | null;
  debit: ParsedAmount | null;
  credit: ParsedAmount | null;
  type: string;
}

function findHeader(rows: Row[]): number {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const h = rows[i].cells.map(normHeader);
    const cols = assignColumns(h);
    const money = cols.amount !== undefined || cols.debit !== undefined || cols.credit !== undefined;
    if (cols.date !== undefined && money && cols.description !== undefined) return i;
  }
  return -1;
}

// No header row: find the date, amount and description columns from the values (Wells Fargo).
function headerless(rows: Row[]): { cols: Columns; layout: string } | null {
  const sample = rows.slice(0, 30);
  const width = Math.max(...sample.map((r) => r.cells.length));
  const frac = (i: number, test: (v: string) => boolean) =>
    sample.filter((r) => r.cells[i] !== undefined && test(r.cells[i])).length / sample.length;
  let date = -1;
  let amount = -1;
  for (let i = 0; i < width; i++) {
    if (date === -1 && frac(i, (v) => parseDate(v) !== null) >= 0.8) date = i;
    else if (amount === -1 && frac(i, (v) => parseAmount(v) !== null && /\d/.test(v)) >= 0.8) amount = i;
  }
  if (date === -1 || amount === -1) return null;
  let description = -1;
  let longest = 0;
  for (let i = 0; i < width; i++) {
    if (i === date || i === amount) continue;
    const avg = sample.reduce((s, r) => s + (r.cells[i]?.trim().length ?? 0), 0) / sample.length;
    if (avg > longest && frac(i, (v) => /[A-Za-z]/.test(v)) >= 0.5) {
      longest = avg;
      description = i;
    }
  }
  if (description === -1) return null;
  const wells =
    width === 5 && date === 0 && amount === 1 && description === 4 && frac(2, (v) => v.trim() === "*") >= 0.5;
  return { cols: { date, amount, description }, layout: wells ? "wells_fargo" : "generic_amount" };
}

export function parseCsv(text: string): StatementResult {
  const body = text.replace(/^\ufeff/, "");
  const rows = readRows(body, sniffDelimiter(body));
  const warnings: string[] = [];
  if (!rows.length) return { txns: [], warnings: ["This file is empty."], format: "csv", layout: "unknown" };

  let cols: Columns;
  let layout: string;
  let data: Row[];
  const headerAt = findHeader(rows);
  if (headerAt !== -1) {
    const headers = rows[headerAt].cells.map(normHeader);
    cols = assignColumns(headers);
    layout = layoutFor(headers, cols);
    data = rows.slice(headerAt + 1);
  } else {
    const guess = headerless(rows);
    if (!guess) {
      return {
        txns: [],
        warnings: ["Tend could not find the date, description, and amount columns in this file."],
        format: "csv",
        layout: "unknown",
      };
    }
    ({ cols, layout } = guess);
    data = rows;
  }

  const skipped: { line: number; why: string }[] = [];
  const skip = (line: number, why: string) => skipped.push({ line, why });
  const order: DateOrder = detectDateOrder(data.map((r) => r.cells[cols.date!] ?? "").filter(Boolean));
  const cell = (r: Row, role: Role) => (cols[role] === undefined ? "" : (r.cells[cols[role]!] ?? ""));
  const drafts: Draft[] = [];
  for (const r of data) {
    const rawDate = cell(r, "date").trim();
    const description = clean(cell(r, "description")) || clean(cell(r, "memo"));
    const amount = parseAmount(cell(r, "amount"));
    const debit = parseAmount(cell(r, "debit"));
    const credit = parseAmount(cell(r, "credit"));
    const anyMoney = amount ?? debit ?? credit;
    if (BALANCE_LINE.test(description) && !(amount && amount.cents)) continue; // a balance line, not a transaction
    const date = parseDate(rawDate, order);
    if (!date) {
      // A header repeated mid-file, or a footer note, is not worth a warning.
      if (
        normHeader(rawDate) &&
        Object.values(ROLES).some((names) => (names as readonly string[]).includes(normHeader(rawDate)))
      )
        continue;
      skip(r.line, "no date Tend could read");
      continue;
    }
    if (!anyMoney) {
      const rawMoney = [cell(r, "amount"), cell(r, "debit"), cell(r, "credit")].join("").trim();
      skip(r.line, rawMoney ? "the amount could not be read" : "no amount");
      continue;
    }
    drafts.push({
      line: r.line,
      date,
      description,
      category: clean(cell(r, "category")) || undefined,
      status: clean(cell(r, "status")) || undefined,
      reference: clean(cell(r, "reference")) || undefined,
      account: clean(cell(r, "account")) || undefined,
      amount,
      debit,
      credit,
      type: clean(cell(r, "type")),
    });
  }

  // A plain signed amount column with no known export: most rows are spending, and paychecks or
  // refunds show which sign means money in.
  let negativeOut = !POSITIVE_IS_OUT.has(layout);
  if (layout === "generic_amount") {
    const typed = drafts.filter((d) => TYPE_OUT.test(d.type) || TYPE_IN.test(d.type)).length;
    if (typed < drafts.length / 2) {
      const income = drafts.filter((d) => d.amount && d.amount.cents && INCOME_WORDS.test(d.description));
      const neg = drafts.filter((d) => d.amount?.negative).length;
      const pos = drafts.filter((d) => d.amount && d.amount.cents && !d.amount.negative).length;
      if (income.length) negativeOut = income.filter((d) => !d.amount!.negative).length >= income.length / 2;
      else negativeOut = neg >= pos;
      warnings.push(negativeOut ? "Read negative amounts as money spent." : "Read positive amounts as money spent.");
    }
  }

  const seen = new Map<string, number>();
  const txns: LocalTxn[] = [];
  for (const d of drafts) {
    let out: number | null;
    if (layout === "capital_one_card" || layout === "citi" || layout === "generic_debit_credit") {
      out = (d.debit?.cents ?? 0) - (d.credit?.cents ?? 0);
      if (!d.debit && !d.credit && d.amount) out = d.amount.negative ? -d.amount.cents : d.amount.cents;
    } else if (d.amount && !d.amount.explicit && (TYPE_OUT.test(d.type) || TYPE_IN.test(d.type))) {
      out = TYPE_OUT.test(d.type) ? d.amount.cents : -d.amount.cents;
    } else if (d.amount) {
      const signed = d.amount.negative ? -d.amount.cents : d.amount.cents;
      out =
        d.amount.marker === "cr"
          ? -d.amount.cents
          : d.amount.marker === "dr"
            ? d.amount.cents
            : negativeOut
              ? -signed
              : signed;
    } else out = null;
    if (out === null) {
      skip(d.line, "the amount could not be read");
      continue;
    }
    if (out === 0) {
      skip(d.line, "the amount is zero");
      continue;
    }
    // The same content gives the same id, so an overlapping second upload is not counted twice.
    const key = [d.date, out, d.description.toLowerCase(), d.reference ?? "", d.account ?? ""].join("|");
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    txns.push({
      id: `csv:${fnv64(`${key}|${n}`)}`,
      date: d.date,
      amount_cents: out,
      description: d.description,
      origin: "csv",
      kind: kindFor(d.description, out),
      ...(d.category ? { category: d.category } : {}),
      ...(d.status ? { status: d.status } : {}),
      line: d.line,
    });
  }
  warnings.unshift(...skipped.sort((a, b) => a.line - b.line).map((w) => `Line ${w.line} skipped: ${w.why}.`));
  if (!txns.length && !warnings.length) warnings.push("No transactions were found in this file.");
  return { txns, warnings, format: "csv", layout };
}
