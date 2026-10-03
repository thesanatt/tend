import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, confirmPayment, normalizeSummaries, proposePayment, resetDataModeForTests } from "@/lib/api";

const pay = {
  bill_id: "b",
  item_ids: ["x"],
  amount_cents: 139400,
  from_account_id: "acct",
  payee: "Riverbend General Hospital",
};

beforeEach(() => {
  resetDataModeForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("not found", { status: 404 })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("demo payments (no API connected)", () => {
  it("proposes the exact amount, payee, and a 6-digit code", async () => {
    const p = await proposePayment(pay, "Checking ending 4821");
    expect(p).toMatchObject({
      demo: true,
      amount_cents: 139400,
      payee: "Riverbend General Hospital",
      from: "Checking ending 4821",
    });
    expect(p.confirm_code).toMatch(/^\d{6}$/);
  });

  it("refuses a wrong code, then confirms once without moving money", async () => {
    const p = await proposePayment(pay, "Checking");
    const wrong = p.confirm_code === "000000" ? "111111" : "000000";
    await expect(confirmPayment(p.action_id, wrong)).rejects.toBeInstanceOf(ApiError);
    const result = await confirmPayment(p.action_id, p.confirm_code);
    expect(result).toMatchObject({ status: "not_sent", amount_cents: 139400 });
    expect(result.message).toMatch(/no money moved/);
    await expect(confirmPayment(p.action_id, p.confirm_code)).rejects.toThrow(/already used/);
  });

  it("expires codes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const p = await proposePayment(pay, "Checking");
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await expect(confirmPayment(p.action_id, p.confirm_code)).rejects.toThrow(/expired/);
  });

  it("refuses fractional cents before anything is proposed", async () => {
    await expect(proposePayment({ ...pay, amount_cents: 10.5 }, "Checking")).rejects.toThrow(/integer cents/);
  });
});

describe("jurisdiction list from the API", () => {
  it("accepts the obvious spellings of the counts", () => {
    expect(
      normalizeSummaries({
        jurisdictions: [
          { jurisdiction: "mi", name: "Michigan", rule_count: 48, source_count: 17, program_name: "CVC" },
          { st: "NY", name: "New York", rules: 46, sources: 13 },
          { st: "", name: "bad" },
        ],
      }),
    ).toEqual([
      { st: "MI", name: "Michigan", rules: 48, sources: 17, program: "CVC", confidence: null, verified_at: null },
      { st: "NY", name: "New York", rules: 46, sources: 13, program: null, confidence: null, verified_at: null },
    ]);
    expect(normalizeSummaries("nope")).toEqual([]);
  });
});
