// Builds Rowan's fictional checking statement as a bank-style PDF, from the same rows as the
// "Use a sample statement" button, and checks that the on-device reader gets the same transactions
// back from the PDF as from the CSV. Run from web/:
//   npx tsx scripts/make-demo-statement.mts [out.pdf]
import { writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { parseStatementBytes } from "../lib/local/statement";
import { ROWAN_OPENING_CENTS, ROWAN_ROWS } from "../components/flow/samples/rowan";
import { sampleStatementCsv } from "../components/flow/samples/index";

const OUT_KINDS = new Set(["purchase", "withdrawal", "transfer", "bill"]);
const out = process.argv[2] ?? "rowan-checking-statement-FICTIONAL.pdf";
const BANNER = "FICTIONAL DEMO DOCUMENT. Not a real bank, account, or person. Made for the Tend demo.";

const money = (cents: number) =>
  `${Math.trunc(Math.abs(cents) / 100).toLocaleString("en-US")}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
const usDate = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

const doc = await PDFDocument.create();
doc.setTitle("Lakeshore Community Bank checking statement (fictional)");
doc.setAuthor("Tend demo");
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const cols = { date: 54, desc: 112, amt: 470, bal: 558 };

let page: PDFPage;
let y = 0;
let pageNo = 0;
const text = (s: string, x: number, yy: number, o: { size?: number; bold?: boolean; right?: boolean } = {}) => {
  const f: PDFFont = o.bold ? bold : font;
  const size = o.size ?? 9;
  page.drawText(s, { x: o.right ? x - f.widthOfTextAtSize(s, size) : x, y: yy, size, font: f });
};
const header = () => {
  text("Date", cols.date, y, { bold: true });
  text("Description", cols.desc, y, { bold: true });
  text("Amount", cols.amt, y, { bold: true, right: true });
  text("Balance", cols.bal, y, { bold: true, right: true });
  y -= 18;
};
const newPage = () => {
  page = doc.addPage([612, 792]);
  pageNo += 1;
  page.drawText(BANNER, { x: 54, y: 765, size: 7, font: bold });
  if (pageNo === 1) {
    text("Lakeshore Community Bank", 54, 730, { size: 15, bold: true });
    text("Checking statement, account ending 0011 (fictional)", 54, 712);
    text("Statement period 04/01/2026 - 09/30/2026", 54, 698);
    text(`Beginning balance  ${money(ROWAN_OPENING_CENTS)}`, 54, 684);
    y = 650;
  } else {
    text("Account activity (continued)", 54, 730, { bold: true });
    y = 706;
  }
  header();
};

newPage();
let balance = ROWAN_OPENING_CENTS;
for (const [date, kind, cents, merchant, description] of ROWAN_ROWS) {
  if (y < 70) {
    text(`Page ${pageNo}`, 290, 40, { size: 8 });
    newPage();
  }
  const outgoing = OUT_KINDS.has(kind);
  balance += outgoing ? -cents : cents;
  const desc = (merchant ? `${merchant} - ${description}` : description).slice(0, 52);
  text(usDate(date), cols.date, y);
  text(desc, cols.desc, y);
  text(`${outgoing ? "-" : "+"}${money(cents)}`, cols.amt, y, { right: true });
  text(money(balance), cols.bal, y, { right: true });
  y -= 13;
}
y -= 6;
text("Ending balance", cols.desc, y, { bold: true });
text(money(balance), cols.bal, y, { right: true, bold: true });
text(`Page ${pageNo}`, 290, 40, { size: 8 });

const bytes = await doc.save({ useObjectStreams: false });
writeFileSync(out, bytes);

const fromPdf = await parseStatementBytes(new Uint8Array(bytes));
const fromCsv = await parseStatementBytes(new TextEncoder().encode(sampleStatementCsv()));
const key = (t: { date: string; amount_cents: number }) => `${t.date} ${t.amount_cents}`;
const pdfKeys = fromPdf.txns.map(key).sort();
const csvKeys = fromCsv.txns.map(key).sort();
const same = pdfKeys.length === csvKeys.length && pdfKeys.every((k, i) => k === csvKeys[i]);
console.log(`wrote ${out}: ${pageNo} pages, ${bytes.length} bytes`);
console.log(`PDF read: ${fromPdf.txns.length} transactions (${fromPdf.format}, ${fromPdf.layout}); CSV: ${fromCsv.txns.length}; same dates and amounts: ${same}`);
if (fromPdf.warnings.length) console.log("warnings:", fromPdf.warnings.slice(0, 5));
