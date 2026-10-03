import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAmount, parseCents, parseDate } from "@/lib/local/amounts";
import { classifier } from "@/lib/local/classify";
import { readRows, sniffDelimiter } from "@/lib/local/csv";
import { lineFinder, parseOfx } from "@/lib/local/ofx";
import type { PdfLine } from "@/lib/local/pdf";
import { statementParser } from "@/lib/local/statement";
import { parseStatementLines } from "@/lib/local/statement-pdf";
import type { LocalTxn, StatementResult } from "@/lib/local/types";

const FIX = path.join(import.meta.dirname, "fixtures");
const load = (rel: string, type = "") => new File([readFileSync(path.join(FIX, rel))], path.basename(rel), { type });
const parse = (rel: string) => statementParser.parse(load(rel));
const rows = (r: StatementResult) => r.txns.map((t) => [t.date, t.amount_cents, t.kind, t.description]);

function contractShape(r: StatementResult) {
  for (const t of r.txns) {
    expect(t.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isSafeInteger(t.amount_cents)).toBe(true);
    expect(t.amount_cents).not.toBe(0);
    expect(t.id).toMatch(/^(csv|ofx|pdf):[0-9a-f]{16}$/);
    expect(t.origin).toBe(r.format);
  }
  expect(new Set(r.txns.map((t) => t.id)).size).toBe(r.txns.length);
}

describe("amounts and dates", () => {
  it.each([
    ["$1,234.56", 123456, false],
    ["-12.34", 1234, true],
    ["(12.34)", 1234, true],
    ["12.34-", 1234, true],
    ["+5", 500, false],
    ["9.5", 950, false],
    ["USD 7.25", 725, false],
    ["$-3.10", 310, true],
    [".5", 50, false],
  ])("%s", (text, cents, negative) => {
    expect(parseAmount(text)).toMatchObject({ cents, negative });
  });

  it("rejects what is not money", () => {
    for (const bad of ["", "abc", "1.234", "12/14", "1,23.00", "--5", "$"]) expect(parseAmount(bad)).toBeNull();
    expect(parseAmount("12.34 CR")).toMatchObject({ cents: 1234, marker: "cr" });
    expect(parseAmount("12.34DR")).toMatchObject({ cents: 1234, marker: "dr" });
  });

  it("reads bill amounts the way api/tend_api/money.py does", () => {
    expect(parseCents("$1,171.75")).toBe(117175);
    expect(parseCents("(12.50)")).toBe(-1250);
    expect(parseCents("$443")).toBe(44300);
    expect(() => parseCents("12.5")).toThrow();
    expect(() => parseCents("(12.50")).toThrow();
  });

  it.each([
    ["06/14/2026", "2026-06-14"],
    ["6/4/26", "2026-06-04"],
    ["2026-06-14", "2026-06-14"],
    ["2026/06/14", "2026-06-14"],
    ["20260614120000[-5:EST]", "2026-06-14"],
    ["Jun 14, 2026", "2026-06-14"],
    ["14 Jun 2026", "2026-06-14"],
    ["June 4 2026", "2026-06-04"],
  ])("date %s", (text, iso) => {
    expect(parseDate(text)).toBe(iso);
  });

  it("refuses impossible dates and reads day-first only when asked", () => {
    expect(parseDate("02/30/2026")).toBeNull();
    expect(parseDate("13/06/2026")).toBeNull();
    expect(parseDate("13/06/2026", "dmy")).toBe("2026-06-13");
  });
});

describe("CSV tokenizer", () => {
  it("handles quotes, doubled quotes, delimiters and newlines inside quotes", () => {
    const got = readRows('a,"b, ""c""",d\r\n"multi\nline",x,\n\n', ",");
    expect(got.map((r) => r.cells)).toEqual([
      ["a", 'b, "c"', "d"],
      ["multi\nline", "x", ""],
    ]);
    expect(got.map((r) => r.line)).toEqual([1, 2]);
  });

  it("sniffs the delimiter", () => {
    expect(sniffDelimiter("a;b;c\n1;2;3\n")).toBe(";");
    expect(sniffDelimiter("a\tb\tc\n1\t2\t3\n")).toBe("\t");
    expect(sniffDelimiter('a,b\n"1;2",3\n')).toBe(",");
  });
});

describe("bank CSV exports", () => {
  it("Capital One card: debit and credit columns, category kept", async () => {
    const r = await parse("csv/capital-one-card.csv");
    expect(r.layout).toBe("capital_one_card");
    expect(rows(r)).toEqual([
      ["2026-06-14", 2300, "purchase", "WAYFARE RIDES TRIP"],
      ["2026-06-15", 2500, "purchase", "HEARTHSTONE PHARMACY RX COPAY"],
      ["2026-06-16", 18500, "purchase", "KEYLINE LOCK & SAFE"],
      ["2026-06-17", 15000, "purchase", "CLEARWATER COUNSELING GROUP"],
      ["2026-06-20", -30000, "deposit", "CAPITAL ONE MOBILE PYMT"],
      ["2026-06-21", 650, "purchase", "COPPER KETTLE COFFEE"],
    ]);
    expect(r.txns[1].category).toBe("Health Care");
    expect(r.warnings).toEqual([]);
    contractShape(r);
  });

  it("Capital One 360: unsigned amounts with a Debit/Credit type, two-digit years", async () => {
    const r = await parse("csv/capital-one-360.csv");
    expect(r.layout).toBe("capital_one_360");
    expect(rows(r).map((x) => x.slice(0, 3))).toEqual([
      ["2026-06-12", -41200, "deposit"],
      ["2026-06-14", 2300, "purchase"],
      ["2026-06-17", 15000, "purchase"],
      ["2026-06-19", 4000, "transfer"],
      ["2026-06-26", -23600, "deposit"],
    ]);
    contractShape(r);
  });

  it("Chase checking: signed amounts, a trailing comma on every row, own transfers", async () => {
    const r = await parse("csv/chase-checking.csv");
    expect(r.layout).toBe("chase_checking");
    expect(rows(r).map((x) => x.slice(1, 3))).toEqual([
      [-41200, "deposit"],
      [2300, "purchase"],
      [18500, "purchase"],
      [15000, "purchase"],
      [4000, "transfer"],
      [30000, "transfer"],
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("Chase card: sales negative, payments and returns positive", async () => {
    const r = await parse("csv/chase-card.csv");
    expect(r.layout).toBe("chase_card");
    expect(r.txns.map((t) => t.amount_cents)).toEqual([2300, -30000, 9600, -2000]);
  });

  it("Bank of America checking: skips the summary block and the balance line", async () => {
    const r = await parse("csv/boa-checking.csv");
    expect(r.layout).toBe("boa_checking");
    expect(r.txns).toHaveLength(7);
    expect(r.txns.map((t) => t.amount_cents)).toEqual([-41200, 2300, 18500, 29900, -23600, 4000, 51100]);
    expect(r.txns[5].kind).toBe("transfer");
    expect(r.warnings).toEqual([]);
  });

  it("Bank of America card", async () => {
    const r = await parse("csv/boa-card.csv");
    expect(r.layout).toBe("boa_card");
    expect(r.txns.map((t) => t.amount_cents)).toEqual([2300, -30000, 1500]);
  });

  it("Wells Fargo: no header row", async () => {
    const r = await parse("csv/wells-fargo.csv");
    expect(r.layout).toBe("wells_fargo");
    expect(rows(r).map((x) => x.slice(0, 2))).toEqual([
      ["2026-06-12", -41200],
      ["2026-06-14", 2300],
      ["2026-06-17", 15000],
      ["2026-06-18", 6400],
      ["2026-06-26", -23600],
    ]);
  });

  it("Citi: debit and credit columns, credits printed negative, pending kept", async () => {
    const r = await parse("csv/citi.csv");
    expect(r.layout).toBe("citi");
    expect(r.txns.map((t) => [t.amount_cents, t.status])).toEqual([
      [2300, "Cleared"],
      [-30000, "Cleared"],
      [1500, "Pending"],
    ]);
  });

  it("American Express: charges positive", async () => {
    const r = await parse("csv/amex.csv");
    expect(r.layout).toBe("amex");
    expect(r.txns.map((t) => t.amount_cents)).toEqual([2300, -30000, 13900]);
  });

  it("a card export with a Type column: a refund or payment printed negative is money in", async () => {
    const r = await parse("csv/typed-card.csv");
    expect(r.layout).toBe("generic_amount");
    expect(rows(r)).toEqual([
      ["2026-06-18", 15000, "purchase", "CLEARWATER COUNSELING GROUP ANN ARBOR MI"],
      ["2026-06-22", 13900, "purchase", "DOWNTOWN HOTEL ANN ARBOR MI"],
      ["2026-06-25", -13900, "deposit", "DOWNTOWN HOTEL ANN ARBOR MI"],
      ["2026-06-30", -50000, "deposit", "ACH DEPOSIT INTERNET TRANSFER FROM ACCOUNT ENDING IN 0042"],
    ]);
    // The refunded hotel night is offered once, not twice.
    const items = await classifier.classify(r.txns, { st: "MI", incident_date: "2026-06-14" }, { deviceAi: false });
    expect(items.map((i) => [i.expense, i.amount_cents])).toEqual([
      ["counseling", 15000],
      ["temporary_housing", 13900],
    ]);
  });

  it("a type column wins over a guess, and rows with a sign keep the bank's convention", async () => {
    const r = await statementParser.parseText(
      [
        "Date,Description,Type,Amount",
        "06/15/2026,ODD SHOP,Debit,-25.00",
        "06/16/2026,ODD SHOP REFUND,Pos,+5.00",
        "06/17/2026,FERNWAY BOOKS PAYROLL,Credit,412.00",
      ].join("\n"),
    );
    expect(r.txns.map((t) => t.amount_cents)).toEqual([2500, -500, -41200]);
  });

  it("generic signed amounts: paychecks show which sign is money in", async () => {
    const r = await parse("csv/generic-signed.csv");
    expect(r.layout).toBe("generic_amount");
    expect(r.txns.map((t) => t.amount_cents)).toEqual([-41200, 2300, 2500, 15000, 1200]);
    expect(r.warnings).toEqual(["Read negative amounts as money spent."]);
  });

  it("generic positive amounts: the payment shows which sign is money in", async () => {
    const r = await parse("csv/generic-positive.csv");
    expect(r.txns.map((t) => t.amount_cents)).toEqual([2300, 2500, 18500, -30000]);
    expect(r.warnings).toEqual(["Read positive amounts as money spent."]);
  });

  it("semicolons, day-first dates, and quoted delimiters", async () => {
    const r = await parse("csv/generic-semicolon.csv");
    expect(r.layout).toBe("generic_debit_credit");
    expect(rows(r)).toEqual([
      ["2026-06-14", 2300, "purchase", 'Wayfare Rides; trip to "Clearwater"'],
      ["2026-06-15", 2500, "purchase", "Hearthstone Pharmacy Rx"],
      ["2026-06-26", -23600, "deposit", "Fernway Books salary"],
    ]);
  });

  it("a file saved from Excel as Unicode Text (UTF-16, tabs) reads like the original", async () => {
    const text = readFileSync(path.join(FIX, "csv/chase-card.csv"), "utf8").replace(/,/g, "\t");
    const utf8 = await statementParser.parseBytes(new TextEncoder().encode(text));
    const le = await statementParser.parseBytes(new Uint8Array([0xff, 0xfe, ...Buffer.from(text, "utf16le")]));
    const be = await statementParser.parseBytes(new Uint8Array([0xfe, 0xff, ...Buffer.from(text, "utf16le").swap16()]));
    expect(utf8.txns.length).toBeGreaterThan(0);
    expect(le).toEqual(utf8);
    expect(be).toEqual(utf8);
  });

  it("a messy file: byte order mark, CRLF, unreadable rows become warnings by line", async () => {
    const r = await parse("csv/messy.csv");
    expect(rows(r)).toEqual([
      ["2026-06-14", 2300, "purchase", "WAYFARE RIDES"],
      ["2026-06-17", 15000, "purchase", "CLEARWATER COUNSELING GROUP"],
      ["2026-06-19", 9650, "purchase", "LINEN & LOOM"],
    ]);
    expect(r.warnings).toEqual([
      "Line 4 skipped: no date Tend could read.",
      "Line 5 skipped: the amount could not be read.",
      "Line 6 skipped: the amount is zero.",
      "Line 8 skipped: no amount.",
    ]);
  });

  it("ids are stable across uploads and distinct for repeated identical rows", async () => {
    const a = await parse("csv/generic-signed.csv");
    const b = await parse("csv/generic-signed.csv");
    expect(a.txns.map((t) => t.id)).toEqual(b.txns.map((t) => t.id));
    const twice = statementParser.parseText(
      "Date,Description,Amount\n2026-06-14,RIDE,-12.00\n2026-06-14,RIDE,-12.00\n",
    );
    expect(twice.txns).toHaveLength(2);
    expect(twice.txns[0].id).not.toBe(twice.txns[1].id);
  });

  it("says so when it cannot find the columns", () => {
    const r = statementParser.parseText("hello\nworld\n");
    expect(r.txns).toEqual([]);
    expect(r.warnings[0]).toMatch(/could not find/);
  });
});

describe("OFX and QFX", () => {
  it("finds line numbers the way a split on any line break would", () => {
    const text = "a\r\nbb\rc\n\nd\r\n\r\ne";
    const at = lineFinder(text);
    for (let i = 0; i <= text.length; i++) {
      if (text[i - 1] === "\r" && text[i] === "\n") continue; // inside one \r\n break, not a place a tag starts
      expect(at(i)).toBe(text.slice(0, i).split(/\r\n|\r|\n/).length);
    }
  });

  it("reads a long export quickly and still names the right line", () => {
    const head = ["OFXHEADER:100", "<OFX>", "<BANKMSGSRSV1><STMTTRNRS><STMTRS>", "<BANKTRANLIST>"];
    const rows = Array.from({ length: 10_000 }, (_, i) =>
      [
        "<STMTTRN>",
        "<TRNTYPE>DEBIT",
        `<DTPOSTED>${i === 9_999 ? "2026" : "20260614"}`,
        `<TRNAMT>-${(i % 90) + 10}.25`,
        `<FITID>F${i}`,
        `<NAME>ODD SHOP ${i}`,
        "</STMTTRN>",
      ].join("\r\n"),
    );
    const text = [...head, ...rows, "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>"].join("\r\n");
    const started = performance.now();
    const r = parseOfx(text);
    expect(performance.now() - started).toBeLessThan(2000); // was about 7 s before line starts were indexed
    expect(r.txns).toHaveLength(9_999);
    expect(r.warnings).toEqual([`Line ${head.length + 7 * 9_999 + 1} skipped: no date Tend could read.`]);
  });

  it("SGML OFX 1.x: unclosed tags, entities, DTUSER first, duplicates and bad dates warned", async () => {
    const r = await parse("ofx/checking.ofx");
    expect(r.format).toBe("ofx");
    expect(rows(r)).toEqual([
      ["2026-06-12", -41200, "deposit", "FERNWAY BOOKS PAYROLL DIRECT DEP FICTIONAL"],
      ["2026-06-14", 2300, "purchase", "WAYFARE RIDES TRIP ANN ARBOR MI"],
      ["2026-06-16", 18500, "purchase", "KEYLINE LOCK & SAFE REKEY AND DEADBOLT INSTALL"],
      ["2026-06-19", 4000, "transfer", "ONLINE TRANSFER TO SAV 0031"],
      ["2026-06-20", 6000, "withdrawal", "ATM WITHDRAWAL 4400 STATE ST"],
      ["2026-06-26", -23600, "deposit", "FERNWAY BOOKS PAYROLL DIRECT DEP FICTIONAL"],
    ]);
    expect(r.warnings).toEqual([
      "Line 82 skipped: the same transaction appears twice.", // the line where its <STMTTRN> opens
      "Line 90 skipped: no date Tend could read.",
    ]);
    contractShape(r);
  });

  it("XML QFX 2.x credit card: purchases negative in the file, positive here", async () => {
    const r = await parse("ofx/card.qfx");
    expect(r.layout).toBe("qfx");
    expect(rows(r)).toEqual([
      ["2026-06-17", 15000, "purchase", "CLEARWATER COUNSELING GROUP"],
      ["2026-06-17", 1200, "purchase", "WAYFARE RIDES TRIP"],
      ["2026-06-20", -30000, "deposit", "PAYMENT THANK YOU"],
      ["2026-06-22", 13900, "purchase", "DOWNTOWN HOTEL ANN ARBOR"],
    ]);
    contractShape(r);
  });
});

describe("PDF statements", () => {
  it("section headings decide direction for unsigned amounts", async () => {
    const r = await parse("statement-sections.pdf");
    expect(r.format).toBe("pdf");
    expect(r.txns).toHaveLength(10);
    expect(r.txns.filter((t) => t.amount_cents < 0).map((t) => [t.date, t.amount_cents])).toEqual([
      ["2026-06-12", -41200],
      ["2026-06-26", -23600],
    ]);
    expect(r.txns.find((t) => t.description === "KEYLINE LOCK & SAFE REKEY AND DEADBOLT")?.amount_cents).toBe(18500);
    expect(r.txns.reduce((s, t) => s + (t.amount_cents > 0 ? t.amount_cents : 0), 0)).toBe(56450); // the statement's own total
    expect(r.warnings).toEqual([]);
    contractShape(r);
  });

  it("table columns decide direction, wrapped lines join the description, balances are not amounts", async () => {
    // Headings are compound ("Deposits/Additions"), and page 2 ends with a daily balance table.
    const r = await parse("statement-table.pdf");
    expect(r.layout).toBe("pdf_table");
    expect(rows(r)).toEqual([
      ["2026-06-12", -41200, "deposit", "Direct deposit FERNWAY BOOKS PAYROLL"],
      ["2026-06-14", 2300, "purchase", "Card purchase WAYFARE RIDES Trip, Ann Arbor MI"],
      ["2026-06-15", 2500, "purchase", "Card purchase HEARTHSTONE PHARMACY Prescription copay"],
      ["2026-06-16", 18500, "purchase", "Card purchase KEYLINE LOCK & SAFE Rekey and deadbolt install"],
      ["2026-06-16", 9600, "purchase", "Card purchase LINEN & LOOM Sheet set, pillows"],
      ["2026-06-19", 4000, "transfer", "Online transfer to savings 0031"],
      ["2026-06-20", 29900, "purchase", "Card purchase BRIGHTLINE WIRELESS New phone"],
      ["2026-06-24", 15000, "purchase", "Card purchase CLEARWATER COUNSELING GROUP"],
      ["2026-06-26", -23600, "deposit", "Direct deposit FERNWAY BOOKS PAYROLL"],
      ["2026-06-29", 6000, "withdrawal", "ATM withdrawal 4400 STATE ST"],
      // After the daily balance table, which is not read, comes a fees section.
      ["2026-06-30", 200, "purchase", "Paper statement fee"],
    ]);
    expect(r.warnings).toEqual(["Page 2, line 7 skipped: it shows only a balance."]);
  });

  it("a card statement across New Year: month-name dates get the right year, payments are money in", async () => {
    const r = await parse("statement-card.pdf");
    expect(rows(r).map((x) => x.slice(0, 2))).toEqual([
      ["2025-12-20", 1800],
      ["2025-12-28", -30000],
      ["2026-01-03", 15000],
      ["2026-01-03", 1400],
      ["2026-01-09", 13900],
      ["2026-01-11", -2000],
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("a PDF with no text says so instead of guessing", async () => {
    const r = await parse("bill-scan-only.pdf");
    expect(r.txns).toEqual([]);
    expect(r.warnings[0]).toMatch(/no text/);
  });

  it("refuses a file that is too large", async () => {
    const r = await statementParser.parseBytes(new Uint8Array(26 * 1024 * 1024));
    expect(r.txns).toEqual([]);
    expect(r.warnings[0]).toMatch(/too large/);
  });
});

describe("every fixture keeps money out positive and in integer cents", () => {
  it.each([
    "csv/capital-one-card.csv",
    "csv/capital-one-360.csv",
    "csv/chase-checking.csv",
    "csv/chase-card.csv",
    "csv/boa-checking.csv",
    "csv/boa-card.csv",
    "csv/wells-fargo.csv",
    "csv/citi.csv",
    "csv/amex.csv",
    "csv/generic-signed.csv",
    "csv/generic-positive.csv",
    "csv/generic-semicolon.csv",
    "csv/typed-card.csv",
    "ofx/checking.ofx",
    "ofx/card.qfx",
    "statement-sections.pdf",
    "statement-table.pdf",
    "statement-card.pdf",
  ])("%s", async (rel) => {
    const r = await parse(rel);
    contractShape(r);
    // Every fixture has a $23 or $18 ride or a counseling charge, and none is read as money in.
    const spending = r.txns.filter((t: LocalTxn) => /WAYFARE|COUNSELING/i.test(t.description));
    expect(spending.length).toBeGreaterThan(0);
    expect(spending.every((t) => t.amount_cents > 0)).toBe(true);
  });
});

describe("PDF line heuristics on their own", () => {
  // One segment per column, as pdf.js gives them; x positions only matter for continuations.
  const lines = (...rows: string[][]): PdfLine[] =>
    rows.map((cells, i) => ({
      page: 1,
      y: 700 - i * 14,
      text: cells.join("  "),
      segments: cells.map((text, j) => ({ text, x: 54 + j * 120, x2: 54 + j * 120 + text.length * 5 })),
    }));

  it("reads CR and DR marks, a Checks heading, and skips balance tables and rows with no words", () => {
    const r = parseStatementLines(
      lines(
        ["Statement period 06/01/2026 - 06/30/2026"],
        ["06/12", "ACME PAYROLL", "412.00 CR"],
        ["06/13", "CORNER STORE", "8.25 DR"],
        ["Checks"],
        ["06/18", "CHECK 1043", "150.00"],
        ["Daily ending balance"],
        ["06/14", "3,239.00", "06/15", "3,214.00"],
        ["Withdrawals"],
        ["06/20", "1234", "9.00"],
        ["06/21", "WAYFARE RIDES", "18.00"],
      ),
    );
    expect(r.txns.map((t) => [t.date, t.amount_cents, t.description])).toEqual([
      ["2026-06-12", -41200, "ACME PAYROLL"],
      ["2026-06-13", 825, "CORNER STORE"],
      ["2026-06-18", 15000, "CHECK 1043"],
      ["2026-06-21", 1800, "WAYFARE RIDES"],
    ]);
    expect(r.warnings).toEqual(["Page 1, line 9 skipped: no description."]);
  });

  it("a dated line with no amount is reported, and a footer is not glued to a row", () => {
    const r = parseStatementLines(
      lines(["Withdrawals"], ["06/20", "PENDING HOLD"], ["06/21", "WAYFARE RIDES", "18.00"], ["Page 1 of 3"]),
    );
    expect(r.txns.map((t) => t.description)).toEqual(["WAYFARE RIDES"]);
    expect(r.warnings).toEqual([
      "The statement period was not found, so dates use this year.",
      "Page 1, line 2 skipped: a dated line with no amount.",
    ]);
  });
});
