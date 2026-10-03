import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { inferPayDips, PAY_DIP_REASON, PAY_GAP_REASON } from "@/lib/local/paydip";
import type { LocalTxn } from "@/lib/local/types";

// Paychecks as money in (negative), every `gap` days from `start`.
function checks(description: string, start: string, gap: number, amounts: (number | null)[]): LocalTxn[] {
  return amounts.flatMap((cents, i) =>
    cents === null
      ? []
      : [
          {
            id: `csv:${description.length}${i}`,
            date: addDays(start, gap * i),
            amount_cents: -cents,
            description,
            origin: "csv" as const,
            kind: "deposit" as const,
          },
        ],
  );
}

const spend = (date: string): LocalTxn => ({
  id: `csv:end${date}`,
  date,
  amount_cents: 500,
  description: "COFFEE",
  origin: "csv",
  kind: "purchase",
});

describe("lost pay from paychecks", () => {
  it("a check clearly below the usual becomes an unconfirmed lost-pay line for its weeks", () => {
    const txns = checks("FERNWAY BOOKS PAYROLL", "2026-05-01", 14, [41200, 39800, 41900, 23600, 41200]);
    const items = inferPayDips(txns, "2026-06-01");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      item_id: `paydip:${txns[3].id}`,
      date: "2026-06-12",
      amount_cents: 41200 - 23600,
      expense: "lost_wages",
      unit: "week",
      units: 2,
      confirmed: false,
      source: "rule",
      reason: PAY_DIP_REASON,
      is_bill: false,
      tags: [],
    });
    expect(items[0].description).toBe("FERNWAY BOOKS PAYROLL: $236.00 paid, usually $412.00");
    expect(items[0].linked_item_ids).toEqual([txns[3].id]);
  });

  it("ignores ordinary wobble: under 10 percent or under $20", () => {
    const txns = checks("ACME PAYROLL", "2026-05-01", 14, [100000, 100000, 100000, 91000, 99000]);
    expect(inferPayDips(txns, "2026-06-01")).toEqual([]);
    const small = checks("SMALL JOB PAYROLL", "2026-05-01", 7, [10000, 10000, 10000, 8500]);
    expect(inferPayDips(small, "2026-05-20")).toEqual([]);
  });

  it("a check that never came becomes a line for the usual amount", () => {
    const txns = [
      ...checks("ACME DIRECT DEP", "2026-05-01", 14, [50000, 50000, 50000, null, null, 50000, 50000]),
      spend("2026-07-31"),
    ];
    const items = inferPayDips(txns, "2026-06-01");
    expect(items.map((i) => [i.date, i.amount_cents, i.reason, i.confirmed, i.units])).toEqual([
      ["2026-06-12", 50000, PAY_GAP_REASON, false, 2],
      ["2026-06-26", 50000, PAY_GAP_REASON, false, 2],
    ]);
    expect(items[0].item_id).toMatch(/^paygap:[0-9a-f]{16}:2026-06-12$/);
  });

  it("does not invent missing checks past the end of the statement", () => {
    const txns = [...checks("ACME DIRECT DEP", "2026-05-01", 14, [50000, 50000, 50000]), spend("2026-06-14")];
    expect(inferPayDips(txns, "2026-06-01")).toEqual([]);
  });

  it("stops looking for the old job's checks once another employer pays", () => {
    const old = checks("OLD JOB PAYROLL", "2026-04-03", 14, [60000, 60000, 60000, 60000]);
    const fresh = checks("NEW JOB PAYROLL", "2026-06-12", 14, [55000, 55000, 55000, 55000]);
    const items = inferPayDips([...old, ...fresh, spend("2026-08-01")], "2026-05-20");
    expect(items.map((i) => i.date)).toEqual(["2026-05-29"]);
  });

  it("needs two checks before the date to know what usual is", () => {
    const txns = checks("ACME PAYROLL", "2026-05-25", 14, [50000, 20000, 20000, 20000]);
    expect(inferPayDips(txns, "2026-06-01")).toEqual([]);
  });

  it("monthly pay counts four weeks a check", () => {
    const txns = checks("CITY SALARY", "2026-01-30", 30, [300000, 300000, 300000, 300000, 150000]);
    const [item] = inferPayDips(txns, "2026-05-01");
    expect(item).toMatchObject({ units: 4, amount_cents: 150000 });
  });

  it("unnamed deposits count only when they come like clockwork", () => {
    const regular = checks("ORBIT LOGISTICS", "2026-04-03", 14, [70000, 70000, 70000, 70000, 30000]);
    expect(inferPayDips(regular, "2026-05-10")).toHaveLength(1);
    const odd: LocalTxn[] = [
      ["2026-04-02", 5000],
      ["2026-04-20", 9000],
      ["2026-05-30", 2000],
      ["2026-06-03", 1500],
    ].map(([date, cents], i) => ({
      id: `csv:v${i}`,
      date: date as string,
      amount_cents: -(cents as number),
      description: "VENMO CASHOUT",
      origin: "csv",
      kind: "deposit",
    }));
    expect(inferPayDips(odd, "2026-05-01")).toEqual([]);
  });

  it("money in that is a transfer between the person's own accounts is not pay", () => {
    const moves = checks("MOVE FROM SAVINGS PAYROLL", "2026-04-03", 14, [40000, 40000, 40000, 10000]).map((t) => ({
      ...t,
      kind: "transfer" as const,
    }));
    expect(inferPayDips(moves, "2026-05-01")).toEqual([]);
  });
});
