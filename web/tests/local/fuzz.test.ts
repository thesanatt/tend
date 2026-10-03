// Odd and broken input never throws: a bad file becomes warnings, never a crash in the survivor's
// browser. A fixed seed keeps every run the same.
import { describe, expect, it } from "vitest";
import { classifyDetailed } from "@/lib/local/classify";
import { fromNessieRelay } from "@/lib/local/nessie";
import { parseStatementBytes, parseStatementText } from "@/lib/local/statement";
import type { LocalTxn } from "@/lib/local/types";

function rng(seed: number) {
  return () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
}

const ctx = { st: "MI", incident_date: "2026-06-14" };

describe("odd input never throws", () => {
  it("random statement text: rows that come out are whole cents on real days, and sort", async () => {
    const r = rng(1);
    const parts = ['"', ",", ";", "\t", "\n", "\r", "-", "(", ")", "$", "1", "2", "0", ".", "/", "a", "Date", "Amount"];
    parts.push("Description", "<OFX>", "<STMTTRN>", "<TRNAMT>", "<DTPOSTED>", "CR", "DR", " ", "é", "﻿");
    for (let k = 0; k < 2000; k++) {
      let s = k % 3 === 0 ? "Date,Description,Amount\n" : "";
      for (let i = Math.floor(r() * 200); i > 0; i--) s += parts[Math.floor(r() * parts.length)];
      const out = parseStatementText(s);
      for (const t of out.txns) {
        expect(Number.isSafeInteger(t.amount_cents)).toBe(true);
        expect(t.amount_cents).not.toBe(0);
        expect(t.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      await classifyDetailed(out.txns, ctx, { deviceAi: false });
    }
  });

  it("random bytes, with and without a PDF header", async () => {
    const r = rng(2);
    for (let k = 0; k < 40; k++) {
      const b = new Uint8Array(600).map(() => Math.floor(r() * 256));
      if (k % 2) b.set(new TextEncoder().encode("%PDF-1.4\n"));
      if (k % 5 === 0) b.set([0xff, 0xfe]);
      const out = await parseStatementBytes(b);
      expect(Array.isArray(out.warnings)).toBe(true);
    }
  });

  it("bank relay bodies of any shape", () => {
    const bodies = [
      null,
      1,
      "x",
      [],
      [null],
      { txns: "x", bills: 5 },
      { transactions: [{ id: 1, date: "2026-06-14", amount: "x" }] },
      { meta: { documents: [null, 1, { bill_id: 5 }] }, bills: [{ id: "b", payee: 3, payment_amount: 10 }] },
      { transactions: [{ id: "a", kind: "purchase", date: "2026-06-14", amount_cents: 1.5 }] },
      { txns: [{ id: "a", kind: "purchase", date: "2026-02-30", amount_cents: 100 }] },
    ];
    for (const body of bodies) {
      const out = fromNessieRelay(body);
      for (const t of out.txns) expect(Number.isSafeInteger(t.amount_cents)).toBe(true);
    }
  });

  it("transactions missing optional text still sort, including deposits", async () => {
    const odd = [
      { id: "csv:1", date: "2026-06-20", amount_cents: 1000, origin: "csv" },
      { id: "csv:2", date: "2026-06-21", amount_cents: -5000, origin: "csv", kind: "deposit" },
      { id: "csv:3", date: "2026-06-22", amount_cents: 2000, description: "", merchant: "", origin: "csv" },
    ] as unknown as LocalTxn[];
    const report = await classifyDetailed(odd, ctx, { deviceAi: false });
    expect(report.all).toHaveLength(3);
  });
});
