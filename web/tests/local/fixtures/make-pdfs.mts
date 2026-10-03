// Builds the fictional PDF fixtures for tests/local (statements and itemized bills).
// Every page says it is a fictional demo document. Run from web/:
//   npx tsx tests/local/fixtures/make-pdfs.mts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";

const OUT = path.dirname(new URL(import.meta.url).pathname);
const FIXED = new Date("2026-10-01T12:00:00Z");
const BANNER = "FICTIONAL DEMO DOCUMENT. Not a real bank, bill, or person. Made for Tend tests.";

interface Ctx {
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
}

async function newDoc(title: string) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setAuthor("Tend test fixtures");
  doc.setProducer("pdf-lib");
  doc.setCreator("tests/local/fixtures/make-pdfs.ts");
  doc.setCreationDate(FIXED);
  doc.setModificationDate(FIXED);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { doc, font, bold };
}

function addPage(doc: PDFDocument, font: PDFFont, bold: PDFFont): Ctx {
  const page = doc.addPage([612, 792]);
  page.drawText(BANNER, { x: 54, y: 760, size: 8, font: bold });
  return { page, font, bold };
}

function text(c: Ctx, s: string, x: number, y: number, opts: { size?: number; bold?: boolean; right?: boolean } = {}) {
  const size = opts.size ?? 9;
  const font = opts.bold ? c.bold : c.font;
  const width = font.widthOfTextAtSize(s, size);
  c.page.drawText(s, { x: opts.right ? x - width : x, y, size, font });
}

const money = (cents: number) => {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
};

async function save(doc: PDFDocument, name: string) {
  const bytes = await doc.save({ useObjectStreams: false });
  writeFileSync(path.join(OUT, name), bytes);
  console.log(`wrote ${name} (${bytes.length} bytes)`);
}

// Style A: a bank statement with section headings and unsigned amounts, one amount per row.
async function statementSections() {
  const { doc, font, bold } = await newDoc("Fictional checking statement (sections)");
  const c = addPage(doc, font, bold);
  text(c, "Lakeside Community Bank", 54, 720, { size: 14, bold: true });
  text(c, "Fictional checking account ending 4821", 54, 704);
  text(c, "June 1, 2026 through June 30, 2026", 400, 720);
  let y = 670;
  let sum = 0;
  const row = (date: string, desc: string, cents: number) => {
    text(c, date, 54, y);
    text(c, desc, 110, y);
    text(c, money(cents), 540, y, { right: true });
    sum += cents;
    y -= 16;
  };
  text(c, "Beginning balance", 54, y);
  text(c, "$2,850.00", 540, y, { right: true });
  y -= 30;
  text(c, "DEPOSITS AND ADDITIONS", 54, y, { bold: true });
  y -= 18;
  row("06/12", "FERNWAY BOOKS PAYROLL PPD", 41200);
  row("06/26", "FERNWAY BOOKS PAYROLL PPD", 23600);
  const deposits = sum;
  sum = 0;
  text(c, "Total deposits and additions", 54, y);
  text(c, `$${money(deposits)}`, 540, y, { right: true });
  y -= 30;
  text(c, "WITHDRAWALS AND PURCHASES", 54, y, { bold: true });
  y -= 18;
  row("06/14", "WAYFARE RIDES TRIP", 2300);
  row("06/15", "HEARTHSTONE PHARMACY RX COPAY", 2500);
  row("06/16", "KEYLINE LOCK & SAFE REKEY AND DEADBOLT", 18500);
  row("06/17", "CLEARWATER COUNSELING GROUP", 15000);
  row("06/17", "WAYFARE RIDES TRIP", 1200);
  row("06/21", "COPPER KETTLE COFFEE", 650);
  row("06/24", "CLEARWATER COUNSELING GROUP", 15000);
  row("06/24", "WAYFARE RIDES TRIP", 1300);
  text(c, "Total withdrawals and purchases", 54, y);
  text(c, `$${money(sum)}`, 540, y, { right: true });
  y -= 30;
  text(c, "Ending balance", 54, y);
  text(c, `$${money(285000 + deposits - sum)}`, 540, y, { right: true });
  text(c, "Every name and number on this page is invented.", 54, 60, { size: 8 });
  await save(doc, "statement-sections.pdf");
}

// Style B: a table with Withdrawals, Deposits and Balance columns, wrapped descriptions, two pages.
async function statementTable() {
  const { doc, font, bold } = await newDoc("Fictional checking statement (table)");
  const cols = { date: 54, desc: 104, out: 410, in: 480, bal: 558 };
  const header = (c: Ctx, y: number) => {
    text(c, "Date", cols.date, y, { bold: true });
    text(c, "Description", cols.desc, y, { bold: true });
    text(c, "Withdrawals/Subtractions", cols.out, y, { bold: true, right: true });
    text(c, "Deposits/Additions", cols.in, y, { bold: true, right: true });
    text(c, "Ending daily balance", cols.bal, y, { bold: true, right: true });
  };
  let c = addPage(doc, font, bold);
  text(c, "Harbor Light Credit Union", 54, 720, { size: 14, bold: true });
  text(c, "Statement period 06/01/2026 - 06/30/2026", 54, 704);
  text(c, "Fictional member account ending 7730", 54, 690);
  let y = 650;
  header(c, y);
  y -= 18;
  let balance = 285000;
  const row = (date: string, desc: string, out: number, inn: number, more: string[] = []) => {
    balance += inn - out;
    text(c, date, cols.date, y);
    text(c, desc, cols.desc, y);
    if (out) text(c, money(out), cols.out, y, { right: true });
    if (inn) text(c, money(inn), cols.in, y, { right: true });
    text(c, money(balance), cols.bal, y, { right: true });
    y -= 13;
    for (const m of more) {
      text(c, m, cols.desc + 12, y, { size: 8 });
      y -= 12;
    }
    y -= 4;
  };
  row("06/12/2026", "Direct deposit FERNWAY BOOKS PAYROLL", 0, 41200);
  row("06/14/2026", "Card purchase WAYFARE RIDES", 2300, 0, ["Trip, Ann Arbor MI"]);
  row("06/15/2026", "Card purchase HEARTHSTONE PHARMACY", 2500, 0, ["Prescription copay"]);
  row("06/16/2026", "Card purchase KEYLINE LOCK & SAFE", 18500, 0, ["Rekey and deadbolt install"]);
  row("06/16/2026", "Card purchase LINEN & LOOM", 9600, 0, ["Sheet set, pillows"]);
  row("06/19/2026", "Online transfer to savings 0031", 4000, 0);
  row("06/20/2026", "Card purchase BRIGHTLINE WIRELESS", 29900, 0, ["New phone"]);
  text(c, "Page 1 of 2", 290, 50, { size: 8 });
  c = addPage(doc, font, bold);
  y = 720;
  text(c, "Account activity (continued)", 54, y, { bold: true });
  y -= 24;
  header(c, y);
  y -= 18;
  row("06/24/2026", "Card purchase CLEARWATER COUNSELING GROUP", 15000, 0);
  row("06/26/2026", "Direct deposit FERNWAY BOOKS PAYROLL", 0, 23600);
  row("06/29/2026", "ATM withdrawal 4400 STATE ST", 6000, 0);
  row("06/30/2026", "Service fee waived", 0, 0);
  text(c, "Ending balance", cols.desc, y);
  text(c, money(balance), cols.bal, y, { right: true });
  y -= 30;
  // A balance table after the activity: dates and amounts, but no transactions.
  text(c, "Daily ending balance", 54, y, { bold: true });
  y -= 16;
  text(c, "06/14", 54, y);
  text(c, "3,239.00", 160, y, { right: true });
  text(c, "06/15", 200, y);
  text(c, "3,214.00", 306, y, { right: true });
  text(c, "06/16", 346, y);
  text(c, "2,933.00", 452, y, { right: true });
  y -= 30;
  text(c, "Fees", 54, y, { bold: true });
  y -= 16;
  text(c, "06/30", cols.date, y);
  text(c, "Paper statement fee", cols.desc, y);
  text(c, "2.00", cols.out, y, { right: true });
  text(c, "Page 2 of 2", 290, 50, { size: 8 });
  await save(doc, "statement-table.pdf");
}

// Style C: a credit card statement across New Year, month-name dates, payments shown negative.
async function statementCard() {
  const { doc, font, bold } = await newDoc("Fictional credit card statement");
  const c = addPage(doc, font, bold);
  text(c, "Northwind Card Services", 54, 720, { size: 14, bold: true });
  text(c, "Fictional credit card account ending 1188", 54, 704);
  text(c, "Billing period Dec 15, 2025 - Jan 14, 2026", 54, 690);
  text(c, "Minimum payment due: $35.00", 360, 690);
  let y = 650;
  text(c, "Trans Date", 54, y, { bold: true });
  text(c, "Post Date", 110, y, { bold: true });
  text(c, "Description", 170, y, { bold: true });
  text(c, "Amount", 540, y, { bold: true, right: true });
  y -= 18;
  const row = (t: string, p: string, desc: string, cents: number) => {
    text(c, t, 54, y);
    text(c, p, 110, y);
    text(c, desc, 170, y);
    text(c, money(cents), 540, y, { right: true });
    y -= 15;
  };
  row("Dec 20", "Dec 21", "WAYFARE RIDES ANN ARBOR MI", 1800);
  row("Dec 28", "Dec 29", "PAYMENT THANK YOU", -30000);
  row("Jan 03", "Jan 04", "CLEARWATER COUNSELING GROUP", 15000);
  row("Jan 03", "Jan 04", "WAYFARE RIDES ANN ARBOR MI", 1400);
  row("Jan 09", "Jan 10", "DOWNTOWN HOTEL ANN ARBOR", 13900);
  row("Jan 11", "Jan 11", "LINEN & LOOM RETURN", -2000);
  y -= 10;
  text(c, "New balance", 54, y);
  text(c, "$1,820.00", 540, y, { right: true });
  await save(doc, "statement-card.pdf");
}

// An itemized bill laid out like the seed's hospital statement, from a different fictional clinic.
async function bill(name: string, lines: [string, string, number, number, number, number][], totalOverride?: number) {
  const { doc, font, bold } = await newDoc("Fictional itemized bill");
  const c = addPage(doc, font, bold);
  text(c, "Lakeside Medical Center", 54, 700, { size: 16, bold: true });
  text(c, "Itemized statement", 558, 700, { size: 12, bold: true, right: true });
  text(c, "40 Shore Rd, Fictional City, MI 48000", 54, 684, { size: 9.5 });
  text(c, "Statement date: 09/15/2026", 558, 684, { size: 9.5, right: true });
  text(c, "Patient billing (555) 555-0199", 54, 671, { size: 9.5 });
  text(c, "Account: LMC-204417", 558, 671, { size: 9.5, right: true });
  const cols: [string, number, "l" | "r"][] = [
    ["Line", 54, "l"],
    ["Date", 80, "l"],
    ["Description", 136, "l"],
    ["Charges", 372, "r"],
    ["Insurance paid", 448, "r"],
    ["Adjustments", 510, "r"],
    ["You owe", 558, "r"],
  ];
  const put = (values: string[], y: number, b = false) =>
    values.forEach((v, i) => text(c, v, cols[i][1], y, { bold: b, right: cols[i][2] === "r" }));
  let y = 620;
  put(cols.map((x) => x[0]), y, true);
  let owed = 0;
  const sums = [0, 0, 0];
  lines.forEach(([date, desc, charge, ins, adj, you], i) => {
    y -= 20;
    put([String(i + 1), date, desc, `$${money(charge)}`, `$${money(ins)}`, `$${money(adj)}`, `$${money(you)}`], y);
    owed += you;
    sums[0] += charge;
    sums[1] += ins;
    sums[2] += adj;
  });
  y -= 24;
  const total = totalOverride ?? owed;
  put(["", "", "Totals", `$${money(sums[0])}`, `$${money(sums[1])}`, `$${money(sums[2])}`, `$${money(total)}`], y, true);
  y -= 40;
  text(c, `Amount due by 10/15/2026: $${money(total)}`, 54, y, { size: 12, bold: true });
  text(c, "Every name, number, and address on this page is invented for a test.", 54, 54, { size: 8 });
  await save(doc, name);
}

// A one-page PDF that is only a picture: no text layer at all.
function tinyPng(width: number, height: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 0, 0, 0, 0], 8); // 8-bit grayscale
  const raw = new Uint8Array((width + 1) * height);
  for (let r = 0; r < height; r++) for (let x = 0; x < width; x++) raw[r * (width + 1) + 1 + x] = (x + r) % 7 ? 255 : 40;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return png;
}

async function scanOnly() {
  const doc = await PDFDocument.create();
  doc.setCreationDate(FIXED);
  doc.setModificationDate(FIXED);
  doc.setTitle("Fictional scanned bill (picture only)");
  const png = await doc.embedPng(tinyPng(64, 80));
  const page = doc.addPage([612, 792]);
  page.drawImage(png, { x: 54, y: 200, width: 504, height: 560 });
  await save(doc, "bill-scan-only.pdf");
  writeFileSync(path.join(OUT, "bill-photo.png"), tinyPng(32, 40));
  console.log("wrote bill-photo.png");
}

await statementSections();
await statementTable();
await statementCard();
await bill("bill-lakeside.pdf", [
  ["09/02/2026", "Emergency department visit, copay", 98000, 78000, 15000, 5000],
  ["09/02/2026", "Sexual assault medical forensic exam", 90000, 0, 0, 90000],
  ["09/02/2026", "Laboratory services, coinsurance", 21500, 13200, 4000, 4300],
  ["09/03/2026", "Pharmacy, medication", 4200, 0, 0, 4200],
]);
await bill(
  "bill-mismatch.pdf",
  [
    ["09/02/2026", "Emergency department visit, copay", 98000, 78000, 15000, 5000],
    ["09/02/2026", "Medical forensic exam", 90000, 0, 0, 90000],
  ],
  99900,
);
await scanOnly();
