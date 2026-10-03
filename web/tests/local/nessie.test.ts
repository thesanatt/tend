import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fetchNessie, fromNessieRelay } from "@/lib/local/nessie";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const snapshot = () => JSON.parse(readFileSync(path.join(ROOT, "seed/snapshots/rowan-mi.json"), "utf8"));

describe("Nessie relay rows", () => {
  it("reads a seed snapshot: every record, money in negative, merchants joined, the bill itemized", () => {
    const snap = snapshot();
    const r = fromNessieRelay(snap);
    expect(r.format).toBe("nessie");
    expect(r.warnings).toEqual([]);
    expect(r.fictional).toBe(true);
    expect(r.label).toMatch(/^Fictional demo data/);
    expect(r.txns).toHaveLength(snap.transactions.length + snap.bills.length);
    const kinds = r.txns.reduce<Record<string, number>>(
      (acc, t) => ({ ...acc, [t.kind!]: (acc[t.kind!] ?? 0) + 1 }),
      {},
    );
    expect(kinds).toEqual({ purchase: 162, deposit: 14, transfer: 8, withdrawal: 6, bill: 1 });
    expect(r.txns.filter((t) => t.kind === "deposit").every((t) => t.amount_cents < 0)).toBe(true);
    expect(r.txns.filter((t) => t.kind !== "deposit").every((t) => t.amount_cents > 0)).toBe(true);
    const session = r.txns.find((t) => t.merchant === "Clearwater Counseling Group")!;
    expect(session).toMatchObject({ category: "health care", description: "session", origin: "nessie" });
    expect(session.id).toMatch(/^nessie:[0-9a-f-]{36}$/);
    const bill = r.txns.find((t) => t.kind === "bill")!;
    expect(bill).toMatchObject({
      merchant: "Riverbend General Hospital",
      amount_cents: 44300,
      date: "2026-06-14",
      itemized: { service_date: "2026-06-14" },
    });
  });

  it("reads raw Nessie records: dollars to cents without float math, _id, typed purchases", () => {
    const r = fromNessieRelay({
      merchants: [{ _id: "m1", name: "Keyline Lock & Safe", category: "home services" }],
      transactions: [
        {
          _id: "p1",
          type: "merchant",
          merchant_id: "m1",
          purchase_date: "2026-06-16",
          amount: 185,
          status: "completed",
          description: "rekey",
        },
        {
          _id: "d1",
          type: "deposit",
          transaction_date: "2026-06-12",
          amount: 412,
          status: "completed",
          description: "payroll",
        },
        {
          _id: "w1",
          type: "withdrawal",
          transaction_date: "2026-06-20",
          amount: 60,
          status: "completed",
          description: "ATM",
        },
        {
          _id: "x1",
          type: "merchant",
          merchant_id: "m1",
          purchase_date: "2026-06-17",
          amount: 5,
          status: "cancelled",
          description: "x",
        },
      ],
      bills: [
        {
          _id: "b1",
          payee: "Lakeside Medical Center",
          nickname: "statement",
          payment_date: "2026-10-20",
          creation_date: "2026-10-03",
          payment_amount: 44.5,
          status: "pending",
        },
      ],
    });
    expect(r.txns.map((t) => [t.id, t.kind, t.date, t.amount_cents, t.merchant ?? null])).toEqual([
      ["nessie:p1", "purchase", "2026-06-16", 18500, "Keyline Lock & Safe"],
      ["nessie:d1", "deposit", "2026-06-12", -41200, null],
      ["nessie:w1", "withdrawal", "2026-06-20", 6000, null],
      ["nessie:b1", "bill", "2026-10-03", 4450, "Lakeside Medical Center"],
    ]);
    expect(r.warnings).toEqual(["1 cancelled record was left out."]);
  });

  it("warns about records it cannot read and keeps the rest", () => {
    const r = fromNessieRelay([
      { id: "a", kind: "purchase", date: "2026-06-14", amount_cents: 1200, description: "ok" },
      { id: "b", kind: "purchase", date: "not-a-date", amount_cents: 1200, description: "bad date" },
      { id: "c", kind: "mystery", date: "2026-06-14", amount_cents: 100 },
      { id: "d", kind: "purchase", date: "2026-06-14", amount: "abc" },
      { id: "a", kind: "purchase", date: "2026-06-14", amount_cents: 1200, description: "again" },
      "not a record",
    ]);
    expect(r.txns.map((t) => t.id)).toEqual(["nessie:a"]);
    expect(r.warnings).toEqual([
      "Record 2 skipped: no date Tend could read.",
      "Record 3 skipped: Tend could not tell what kind of record it is.",
      "Record 4 skipped: the amount could not be read.",
      "Record 5 skipped: the same record appears twice.",
      "Record 6 skipped: not a bank record.",
    ]);
  });

  it("an empty or odd body gives no rows, not an error", () => {
    expect(fromNessieRelay(null).txns).toEqual([]);
    expect(fromNessieRelay({ rows: [] }).txns).toEqual([]);
  });
});

describe("fetching through the relay", () => {
  it("calls the persona's transactions route and reads the answer", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify(snapshot()), { headers: { "content-type": "application/json" } }),
    );
    const r = await fetchNessie("rowan-mi", { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0] as unknown[])[0]).toBe("/api/bank/rowan-mi/transactions");
    expect(r.txns.length).toBe(191);
  });

  it("throws a plain error when the relay is down or answers HTML", async () => {
    const down = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    await expect(fetchNessie("rowan-mi", { fetch: down as unknown as typeof globalThis.fetch })).rejects.toThrow(
      "The bank relay answered 502.",
    );
    const html = vi.fn(async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(fetchNessie("rowan-mi", { fetch: html as unknown as typeof globalThis.fetch })).rejects.toThrow();
  });
});
