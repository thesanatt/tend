// Rowan's fictional checking statement as a bank-style PDF, built in the browser with pdf-lib from the
// same rows as sampleStatementCsv(). The on-device reader gets the same 190 transactions back from it
// (tests/sample-statement.test.ts). Layout from scripts/make-demo-statement.mts.
import type { PDFFont, PDFPage } from "pdf-lib";
import { ROWAN_OPENING_CENTS, ROWAN_ROWS } from "./rowan";

// Kinds that take money out of the account; the rest (deposits) bring it in.
export const OUT_KINDS = new Set(["purchase", "withdrawal", "transfer", "bill"]);

const BANNER = "FICTIONAL DEMO DOCUMENT. Not a real bank, account, or person. Made for the Tend demo.";
const COLS = { date: 54, desc: 112, amt: 470, bal: 558 };

const money = (cents: number) =>
  `${Math.trunc(Math.abs(cents) / 100).toLocaleString("en-US")}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
const usDate = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

export async function sampleStatementPdf(): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.setTitle("Lakeshore Community Bank checking statement (fictional)");
  doc.setAuthor("Tend demo");
  // A fixed date keeps the file the same on every build, so it reads as the same record each time.
  const made = new Date("2026-10-03T12:00:00Z");
  doc.setCreationDate(made);
  doc.setModificationDate(made);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page!: PDFPage;
  let y = 0;
  const text = (s: string, x: number, yy: number, o: { size?: number; bold?: boolean; right?: boolean } = {}) => {
    const f: PDFFont = o.bold ? bold : font;
    const size = o.size ?? 9;
    page.drawText(s, { x: o.right ? x - f.widthOfTextAtSize(s, size) : x, y: yy, size, font: f });
  };
  const header = () => {
    text("Date", COLS.date, y, { bold: true });
    text("Description", COLS.desc, y, { bold: true });
    text("Amount", COLS.amt, y, { bold: true, right: true });
    text("Balance", COLS.bal, y, { bold: true, right: true });
    y -= 18;
  };
  const newPage = () => {
    page = doc.addPage([612, 792]);
    page.drawText(BANNER, { x: 54, y: 765, size: 7, font: bold });
    if (doc.getPageCount() === 1) {
      const first = ROWAN_ROWS[0][0];
      const last = ROWAN_ROWS[ROWAN_ROWS.length - 1][0];
      text("Lakeshore Community Bank", 54, 730, { size: 15, bold: true });
      text("Checking statement, account ending 0011 (fictional)", 54, 712);
      text(`Statement period ${usDate(first)} - ${usDate(last)}`, 54, 698);
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
    if (y < 70) newPage();
    const outgoing = OUT_KINDS.has(kind);
    balance += outgoing ? -cents : cents;
    text(usDate(date), COLS.date, y);
    text((merchant ? `${merchant} - ${description}` : description).slice(0, 52), COLS.desc, y);
    text(`${outgoing ? "-" : "+"}${money(cents)}`, COLS.amt, y, { right: true });
    text(money(balance), COLS.bal, y, { right: true });
    y -= 13;
  }
  y -= 6;
  text("Ending balance", COLS.desc, y, { bold: true });
  text(money(balance), COLS.bal, y, { right: true, bold: true });

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    page = p;
    const label = `Page ${i + 1} of ${pages.length}`;
    text(label, 306 - font.widthOfTextAtSize(label, 8) / 2, 40, { size: 8 });
  });
  return doc.save({ useObjectStreams: false });
}
