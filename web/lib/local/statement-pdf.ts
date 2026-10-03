// Bank and card statements as PDF: rows are found by line heuristics on the text pdf.js extracts.
// A row starts with a date (06/14, 06/14/26, Jun 14) and ends with one or more amounts. Which way
// money moved comes from, in order: a CR/DR mark, the table column the amount sits under, the
// section it is listed in (Deposits, Withdrawals, Payments and credits), its sign, and last the
// words in the row. Anything that looks like a row but cannot be read becomes a warning.
import { isoDay, monthNumber, parseAmount, parseDate, type ParsedAmount } from "./amounts";
import { kindFor } from "./csv";
import { fnv64 } from "./hash";
import { pdfLines, type PdfLine, type PdfSegment } from "./pdf";
import type { LocalTxn, StatementResult } from "./types";

const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?";
const DAY = `(?:\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?|${MONTH}\\s+\\d{1,2})`;
const ROW = new RegExp(`^(?<d1>${DAY})\\s+(?:(?<d2>${DAY})\\s+)?(?<rest>.*)$`, "i");
const AMOUNT = String.raw`\(?[-+]?\$?\s?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\)?-?(?:\s?(?:CR|DR)\b)?`;
const TRAILING = new RegExp(`(?:^|\\s)(${AMOUNT})\\s*$`, "i");

const SKIP_ROW =
  /\b(beginning|ending|opening|closing|previous|new|daily|average|available)\s+(ledger\s+)?balance\b|\bbalance (forward|brought forward)\b|\b(sub)?totals?\b/i;
const SECTION_IN =
  /\b(deposits?|additions|credits|incoming|interest (paid|earned)|refunds?)\b|\bpayments?,? (and|&) (other )?credits\b/i;
const SECTION_OUT =
  /\b(withdrawals?|subtractions|debits|purchases?|checks? paid|fees|charges|outgoing|payments? (sent|made)|card transactions|atm)\b|^checks?$/i;
// Tables of balances, not transactions: rows under these headings are not read.
const SECTION_SKIP = /\b(daily (ending )?balances?|ending daily balances?|balance summary|account summary)\b/i;
const SENTENCE = /\b(are|is|was|were|your|our|you|will|may|please|if|call)\b|\.$/i;
const INCOME_WORDS =
  /payroll|direct dep|dir dep|salary|\bdeposit\b|refund|interest paid|payment thank you|thank you|\breturn\b/i;
const CARD_DOC = /credit card|card account|minimum payment|credit limit|new balance/i;
const FOOTER = /^page \d+|\bmember fdic\b|^continued\b/i;

type Direction = "in" | "out";
type Section = Direction | "skip" | null;
type Column = "date" | "description" | "amount" | "debit" | "credit" | "balance";

// Column headings, tested on short segments; compound ones such as "Deposits/Additions" count.
const COLUMN_WORDS: [RegExp, Column][] = [
  [/\bbalance\b/i, "balance"],
  [/\b(withdrawals?|subtractions|debits?|charges|money out|paid out|amount debited)\b/i, "debit"],
  [/\b(deposits?|additions|credits?|payments?|money in|paid in|amount credited)\b/i, "credit"],
  [/^(amount|amount \(\$\)|transaction amount)$/i, "amount"],
  [/^(description|transaction description|details|transaction)$/i, "description"],
  [/^(date|trans(action)? date|post(ing|ed)? date|tran date)$/i, "date"],
];

interface Period {
  start: string | null;
  end: string | null;
}

function findPeriod(text: string): Period {
  const num = /(\d{1,2}\/\d{1,2}\/\d{2,4})\s*(?:-|\u2013|to|through|thru)\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(text);
  if (num) return { start: parseDate(num[1]), end: parseDate(num[2]) };
  const named = new RegExp(
    `(${MONTH}\\s+\\d{1,2},?\\s+\\d{4})\\s*(?:-|\\u2013|to|through|thru)\\s*(${MONTH}\\s+\\d{1,2},?\\s+\\d{4})`,
    "i",
  ).exec(text);
  if (named) return { start: parseDate(named[1]), end: parseDate(named[2]) };
  const closing = new RegExp(
    `(?:statement|closing) (?:closing )?date:?\\s*(\\d{1,2}/\\d{1,2}/\\d{2,4}|${MONTH}\\s+\\d{1,2},?\\s+\\d{4})`,
    "i",
  ).exec(text);
  if (closing) return { start: null, end: parseDate(closing[1]) };
  return { start: null, end: null };
}

const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

// A row date without a year takes the year that puts it inside the statement period.
function rowDate(token: string, period: Period, fallbackYear: number): string | null {
  const full = parseDate(token);
  if (full) return full;
  let month: number | null = null;
  let day: number | null = null;
  const num = /^(\d{1,2})\/(\d{1,2})$/.exec(token);
  if (num) {
    month = Number(num[1]);
    day = Number(num[2]);
  } else {
    const named = /^([A-Za-z]+)\.?\s+(\d{1,2})$/.exec(token);
    if (named) {
      month = monthNumber(named[1]);
      day = Number(named[2]);
    }
  }
  if (!month || !day) return null;
  const endYear = period.end ? Number(period.end.slice(0, 4)) : fallbackYear;
  if (period.start || period.end) {
    const lo = dayNumber(period.start ?? period.end!) - 45;
    const hi = dayNumber(period.end ?? period.start!) + 45;
    for (const y of [endYear, endYear - 1, endYear + 1]) {
      const iso = isoDay(y, month, day);
      if (iso && dayNumber(iso) >= lo && dayNumber(iso) <= hi) return iso;
    }
  }
  return isoDay(endYear, month, day);
}

type Header = { column: Column; x: number; x2: number }[];

function headerColumns(line: PdfLine): Header | null {
  const columns: Header = [];
  for (const s of line.segments) {
    if (s.text.trim().length > 40) continue;
    const hit = COLUMN_WORDS.find(([re]) => re.test(s.text.trim()));
    if (hit) columns.push({ column: hit[1], x: s.x, x2: s.x2 });
  }
  const money = columns.filter((c) => c.column !== "date" && c.column !== "description");
  return columns.some((c) => c.column === "date") && money.length >= 1 && columns.length >= 3 ? columns : null;
}

// The amount tokens at the end of a row, in reading order, and the text before them.
function trailingAmounts(text: string): { tokens: string[]; rest: string } {
  const tokens: string[] = [];
  let rest = text;
  for (let i = 0; i < 4; i++) {
    const m = TRAILING.exec(rest);
    if (!m) break;
    tokens.unshift(m[1].trim());
    rest = rest.slice(0, m.index).trimEnd();
  }
  return { tokens, rest };
}

function segmentFor(token: string, segments: PdfSegment[], used: Set<PdfSegment>): PdfSegment | null {
  const bare = token.replace(/\s+/g, "");
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (!used.has(s) && s.text.replace(/\s+/g, "").endsWith(bare)) {
      used.add(s);
      return s;
    }
  }
  return null;
}

function nearestColumn(seg: PdfSegment, header: Header): Column | null {
  let best: Column | null = null;
  let bestDistance = Infinity;
  for (const c of header) {
    if (c.column === "date" || c.column === "description") continue;
    // Numbers line up on their right edge; headings are often centered, so compare both.
    const d = Math.min(Math.abs(seg.x2 - c.x2), Math.abs((seg.x + seg.x2) / 2 - (c.x + c.x2) / 2));
    if (d < bestDistance) {
      bestDistance = d;
      best = c.column;
    }
  }
  return bestDistance <= 60 ? best : null;
}

// A short heading such as "Deposits and additions" sets which way the rows under it go.
function sectionOf(text: string): Section | undefined {
  if (text.length > 60 || text.split(/\s+/).length > 6 || SENTENCE.test(text) || ROW.test(text) || TRAILING.test(text))
    return undefined;
  if (SECTION_SKIP.test(text)) return "skip";
  const isIn = SECTION_IN.test(text);
  const isOut = SECTION_OUT.test(text);
  if (isIn && !isOut) return "in";
  if (isOut && !isIn) return "out";
  if (isIn && isOut) return /\bpayments?,? (and|&) (other )?credits\b/i.test(text) ? "in" : null;
  return undefined;
}

export function parseStatementLines(lines: PdfLine[]): StatementResult {
  const warnings: string[] = [];
  const text = lines.map((l) => l.text).join("\n");
  const period = findPeriod(text);
  const card = CARD_DOC.test(text);
  const years = [...text.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
  const fallbackYear = years.length ? Math.max(...years) : new Date().getUTCFullYear();
  if (!period.end && !years.length) warnings.push("The statement period was not found, so dates use this year.");

  let section: Section = null;
  let header: Header | null = null;
  let sawHeader = false;
  let guessed = 0;
  const txns: LocalTxn[] = [];
  const seen = new Map<string, number>();
  let last: { txn: LocalTxn; x: number; y: number; page: number; extra: number } | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineNo = index + 1;
    const t = line.text;
    const h = headerColumns(line);
    if (h) {
      header = h;
      sawHeader = true;
      last = null;
      continue;
    }
    const sec = sectionOf(t);
    if (sec !== undefined) {
      section = sec;
      last = null;
      continue;
    }
    if (section === "skip") continue;
    const row = ROW.exec(t);
    const { tokens, rest } = trailingAmounts(row ? row.groups!.rest : t);
    if (!row) {
      // Indented text right under a row, with no date and no amount, continues its description.
      const first = line.segments[0];
      const near = last && last.page === line.page && Math.abs(last.y - line.y) < 24;
      if (
        last &&
        near &&
        !tokens.length &&
        first &&
        first.x > last.x + 8 &&
        last.extra < 2 &&
        t.length <= 80 &&
        !FOOTER.test(t)
      ) {
        last.txn.description = `${last.txn.description} ${t.replace(/\s+/g, " ").trim()}`;
        last.extra++;
        last.y = line.y;
      } else last = null;
      continue;
    }
    last = null;
    const description = rest.replace(/\s+/g, " ").trim();
    if (SKIP_ROW.test(description)) continue;
    if (!tokens.length) {
      warnings.push(`Line ${lineNo} skipped: a dated line with no amount.`);
      continue;
    }
    const date = rowDate(row.groups!.d1.trim(), period, fallbackYear);
    if (!date) {
      warnings.push(`Line ${lineNo} skipped: no date Tend could read.`);
      continue;
    }
    if (!/[A-Za-z]{2}/.test(description)) {
      warnings.push(`Line ${lineNo} skipped: no description.`);
      continue;
    }

    // Place each amount under a column when the table has a header.
    const used = new Set<PdfSegment>();
    const placed = tokens.map((token) => {
      const seg = segmentFor(token, line.segments, used);
      return { amount: parseAmount(token), column: header && seg ? nearestColumn(seg, header) : null };
    });
    let pick: { amount: ParsedAmount; column: Column | null } | null = null;
    if (header) {
      const inColumn = placed.find((p) => p.column && p.column !== "balance" && p.amount);
      if (inColumn) pick = { amount: inColumn.amount!, column: inColumn.column };
    }
    if (!pick) {
      // No usable header: the first amount is the amount; any after it is a running balance.
      const first = placed.find((p) => p.column !== "balance");
      if (!first) {
        warnings.push(`Line ${lineNo} skipped: it shows only a balance.`);
        continue;
      }
      if (first.amount) pick = { amount: first.amount, column: null };
    }
    if (!pick || !pick.amount.cents) {
      warnings.push(
        pick ? `Line ${lineNo} skipped: the amount is zero.` : `Line ${lineNo} skipped: the amount could not be read.`,
      );
      continue;
    }

    let direction: Direction;
    const a = pick.amount;
    if (a.marker) direction = a.marker === "cr" ? "in" : "out";
    else if (pick.column === "debit") direction = "out";
    else if (pick.column === "credit") direction = "in";
    else if (section === "in" || section === "out") direction = section;
    else if (a.explicit && a.negative) direction = card ? "in" : "out";
    else if (a.explicit) direction = card ? "out" : "in";
    else if (card)
      direction = INCOME_WORDS.test(description) ? "in" : "out"; // card charges print unsigned
    else {
      direction = INCOME_WORDS.test(description) ? "in" : "out";
      guessed++;
    }
    const out = direction === "out" ? a.cents : -a.cents;
    const key = [date, out, description.toLowerCase()].join("|");
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const txn: LocalTxn = {
      id: `pdf:${fnv64(`${key}|${n}`)}`,
      date,
      amount_cents: out,
      description,
      origin: "pdf",
      kind: kindFor(description, out),
      line: lineNo,
    };
    txns.push(txn);
    last = { txn, x: line.segments[0]?.x ?? 0, y: line.y, page: line.page, extra: 0 };
  }

  // Descriptions may have grown from continuation lines; kinds follow the final text.
  for (const txn of txns) txn.kind = kindFor(txn.description, txn.amount_cents);
  if (guessed)
    warnings.push(
      `${guessed} amount${guessed === 1 ? " had" : "s had"} no sign or section, so Tend read ${guessed === 1 ? "it" : "them"} as money spent unless the words said otherwise.`,
    );
  if (!txns.length)
    warnings.push("No transactions were found in this PDF. The CSV or OFX download from your bank may work better.");
  return { txns, warnings, format: "pdf", layout: sawHeader ? "pdf_table" : "pdf_lines" };
}

export async function parsePdfStatement(bytes: Uint8Array): Promise<StatementResult> {
  const { lines } = await pdfLines(bytes);
  if (!lines.length) {
    return {
      txns: [],
      warnings: [
        "This PDF has no text Tend can read on this device. The CSV or OFX download from your bank will work.",
      ],
      format: "pdf",
      layout: "unknown",
    };
  }
  return parseStatementLines(lines);
}
