// OFX and QFX (Quicken's OFX) statements, both the SGML 1.x form with unclosed tags and the XML
// 2.x form. TRNAMT is from the account holder's side: negative is money out, for bank and card
// statements alike.
import { parseAmount, parseDate } from "./amounts";
import { kindFor } from "./csv";
import { fnv64 } from "./hash";
import type { LocalTxn, StatementResult, TxnKind } from "./types";

export function looksLikeOfx(text: string): boolean {
  const head = text.slice(0, 4096);
  return /OFXHEADER\s*:/i.test(head) || /<OFX>/i.test(head) || /<\?OFX\s/i.test(head);
}

function decode(value: string): string {
  return value
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/gi, "&");
}

// The text after <TAG> up to the next tag or line end. Works for <TAG>v</TAG> and SGML <TAG>v.
function leaf(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i").exec(block);
  return m ? decode(m[1]).trim() : null;
}

// Each <TAG>...</TAG> body, with where the body starts in text (just after the opening tag), so
// a position inside a body plus start is a position in text.
function blocks(text: string, tag: string): { body: string; start: number }[] {
  const out: { body: string; start: number }[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ body: m[1], start: m.index + tag.length + 2 });
  return out;
}

// The 1-based line of a position in the text. Line starts are found once, so a long export with
// thousands of transactions does not rescan the file for each one.
export function lineFinder(text: string): (index: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13 && text.charCodeAt(i + 1) === 10) i++; // \r\n is one break
    if (c === 10 || c === 13) starts.push(i + 1);
  }
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const TRNTYPE_KIND: Record<string, TxnKind> = {
  ATM: "withdrawal",
  CASH: "withdrawal",
  DEP: "deposit",
  DIRECTDEP: "deposit",
  INT: "deposit",
  DIV: "deposit",
};

export function parseOfx(text: string): StatementResult {
  const warnings: string[] = [];
  const txns: LocalTxn[] = [];
  const statements = [...blocks(text, "STMTRS"), ...blocks(text, "CCSTMTRS")];
  const scopes = statements.length ? statements : [{ body: text, start: 0 }];
  const seen = new Map<string, number>();
  const lineAt = lineFinder(text);
  let layout = "ofx";
  if (/<INTU\.BID>/i.test(text)) layout = "qfx";
  for (const scope of scopes) {
    const account = leaf(scope.body, "ACCTID") ?? "";
    const acct = account.replace(/\W/g, "").slice(-4);
    for (const t of blocks(scope.body, "STMTTRN")) {
      const line = lineAt(scope.start + t.start);
      const rawDate = leaf(t.body, "DTUSER") || leaf(t.body, "DTPOSTED");
      const date = parseDate(rawDate);
      const amount = parseAmount(leaf(t.body, "TRNAMT"));
      if (!date) {
        warnings.push(`Line ${line} skipped: no date Tend could read.`);
        continue;
      }
      if (!amount) {
        warnings.push(`Line ${line} skipped: the amount could not be read.`);
        continue;
      }
      if (!amount.cents) {
        warnings.push(`Line ${line} skipped: the amount is zero.`);
        continue;
      }
      const out = amount.negative ? amount.cents : -amount.cents;
      const name = (leaf(t.body, "NAME") ?? leaf(t.body, "PAYEE") ?? "").replace(/\s+/g, " ");
      const memo = (leaf(t.body, "MEMO") ?? "").replace(/\s+/g, " ");
      // NAME is the payee (often cut short); MEMO may repeat it or add detail.
      const lowName = name.toLowerCase();
      const lowMemo = memo.toLowerCase();
      const description =
        !memo || lowName.includes(lowMemo) ? name : !name || lowMemo.includes(lowName) ? memo : `${name} ${memo}`;
      const trntype = (leaf(t.body, "TRNTYPE") ?? "").toUpperCase();
      const fitid = leaf(t.body, "FITID");
      const key = fitid ? `${acct}|${fitid}` : `${acct}|${date}|${out}|${description.toLowerCase()}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (fitid && n > 1) {
        warnings.push(`Line ${line} skipped: the same transaction appears twice.`);
        continue;
      }
      const kind: TxnKind = out < 0 ? "deposit" : (TRNTYPE_KIND[trntype] ?? kindFor(description, out));
      txns.push({ id: `ofx:${fnv64(`${key}|${n}`)}`, date, amount_cents: out, description, origin: "ofx", kind, line });
    }
  }
  if (!txns.length && !warnings.length) warnings.push("No transactions were found in this file.");
  return { txns, warnings, format: "ofx", layout };
}
