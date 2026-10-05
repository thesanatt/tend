// The sample statement is a bank-style PDF built in the browser. The on-device reader must get the
// same transactions back from it as from the plain CSV export of the same fictional account.
import { describe, expect, it } from "vitest";
import {
  SAMPLE_STATEMENT_NAME,
  sampleStatementCsv,
  sampleStatementFile,
  sampleStatementPdf,
} from "@/components/flow/samples";
import { pdfLines } from "@/lib/local/pdf";
import { parseStatementBytes } from "@/lib/local/statement";
import type { LocalTxn } from "@/lib/local/types";

const key = (t: LocalTxn) => `${t.date} ${t.amount_cents}`;

describe("sample statement PDF", () => {
  it("reads as exactly the same 190 transactions as the CSV, with the same dates and signed amounts", async () => {
    const fromPdf = await parseStatementBytes(await sampleStatementPdf());
    const fromCsv = await parseStatementBytes(new TextEncoder().encode(sampleStatementCsv()));
    expect(fromPdf.format).toBe("pdf");
    expect(fromPdf.warnings).toEqual([]);
    expect(fromCsv.txns).toHaveLength(190);
    expect(fromPdf.txns).toHaveLength(190);
    // Row by row, in statement order: same day, same amount, same direction, same words.
    expect(fromPdf.txns.map((t) => [t.date, t.amount_cents, t.description])).toEqual(
      fromCsv.txns.map((t) => [t.date, t.amount_cents, t.description]),
    );
    expect(fromPdf.txns.map(key).sort()).toEqual(fromCsv.txns.map(key).sort());
    // Paychecks come in (negative in the contract); everything else goes out.
    const pay = fromPdf.txns.filter((t) => /payroll/i.test(t.description));
    expect(pay.length).toBeGreaterThan(0);
    expect(pay.every((t) => t.amount_cents < 0)).toBe(true);
  }, 30_000);

  it("looks like a bank statement: bank name, account, period, balance, columns, banner and page numbers", async () => {
    const { lines, pages } = await pdfLines(await sampleStatementPdf());
    const text = lines.map((l) => l.text);
    expect(pages).toBe(5);
    expect(text).toContain("Lakeshore Community Bank");
    expect(text).toContain("Checking statement, account ending 0011 (fictional)");
    expect(text).toContain("Statement period 04/01/2026 - 10/02/2026");
    expect(text.some((l) => /^Beginning balance\s+2,850\.00$/.test(l))).toBe(true);
    for (let p = 1; p <= pages; p++) {
      const on = lines.filter((l) => l.page === p).map((l) => l.text);
      expect(on[0]).toMatch(/^FICTIONAL DEMO DOCUMENT\./);
      expect(on.some((l) => /^Date\s+Description\s+Amount\s+Balance$/.test(l))).toBe(true);
      expect(on).toContain(`Page ${p} of ${pages}`);
    }
    // Money out carries a minus sign, deposits an explicit plus.
    expect(text.some((l) => /^04\/01\/2026\s+Larkfield Market - groceries\s+-19\.00\s+2,831\.00$/.test(l))).toBe(true);
    expect(text.some((l) => /^04\/03\/2026\s+Fernway Books payroll\s+\+412\.00\s+3,243\.00$/.test(l))).toBe(true);
  }, 30_000);

  it("is a PDF file with the sample name, the same bytes every time", async () => {
    const file = await sampleStatementFile();
    expect(file.name).toBe(SAMPLE_STATEMENT_NAME);
    expect(file.name).toMatch(/fictional\.pdf$/);
    expect(file.type).toBe("application/pdf");
    const a = new Uint8Array(await file.arrayBuffer());
    const b = await sampleStatementPdf();
    expect(new TextDecoder("latin1").decode(a.slice(0, 5))).toBe("%PDF-");
    expect(a).toEqual(b);
  }, 30_000);
});
