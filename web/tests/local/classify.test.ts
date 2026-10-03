import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifier, classifyDetailed, DEVICE_BATCH, responseSchema } from "@/lib/local/classify";
import { fromNessieRelay } from "@/lib/local/nessie";
import { MODEL_LABELS } from "@/lib/local/rules";
import { statementParser } from "@/lib/local/statement";
import type { LocalTxn } from "@/lib/local/types";
import { EXPENSES } from "@/lib/types";
import { FakeLanguageModel, install, rowsOf, uninstall } from "./fake-lm";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const FIX = path.join(import.meta.dirname, "fixtures");
const ctx = { st: "MI", incident_date: "2026-06-14" };
const rowan = () => JSON.parse(readFileSync(path.join(ROOT, "seed/snapshots/rowan-mi.json"), "utf8"));

let n = 0;
const txn = (description: string, amount_cents: number, extra: Partial<LocalTxn> = {}): LocalTxn => ({
  id: `csv:${(++n).toString(16).padStart(16, "0")}`,
  date: "2026-06-20",
  amount_cents,
  description,
  origin: "csv",
  ...extra,
});

// Unclear rows only a model can sort: no keyword rule matches any of them.
const unclear = (count: number) =>
  Array.from({ length: count }, (_, i) => txn(`ODD SHOP ITEM ${String.fromCharCode(65 + i)}`, 1000 + i));

afterEach(() => {
  uninstall();
  vi.restoreAllMocks();
});

describe("rules first", () => {
  it("sorts a bank CSV end to end without any model", async () => {
    const { txns } = await statementParser.parse(
      new File([readFileSync(path.join(FIX, "csv/boa-checking.csv"))], "x.csv"),
    );
    const report = await classifyDetailed(txns, ctx);
    expect(report.device.status).toBe("unavailable");
    expect(report.items.map((i) => [i.expense, i.amount_cents, i.confirmed, i.source])).toEqual([
      ["security", 18500, true, "rule"],
      ["property_replacement", 29900, true, "rule"],
      ["relocation", 51100, true, "rule"],
    ]);
    // The new phone carries the law's "phone" tag, so a state that excludes phones can say so.
    expect(report.items[1].tags).toEqual(["phone"]);
  });

  it("emits engine items with unit, tags, source, reason and confidence", async () => {
    const report = await classifyDetailed([txn("CLEARWATER COUNSELING GROUP", 15000), txn("WAYFARE RIDES", 1200)], ctx);
    const [counseling, ride] = report.items;
    expect(counseling).toMatchObject({
      expense: "counseling",
      unit: "session",
      units: 1,
      tags: [],
      source: "rule",
      confirmed: true,
      confidence: 0.9,
      insurance_paid_cents: 0,
      is_bill: false,
    });
    // A ride on a counseling day is an inference: always asked, never pre-checked.
    expect(ride).toMatchObject({ expense: "transportation", confirmed: false, method: "link", unit: null, units: 0 });
    expect(ride.linked_item_ids).toEqual([counseling.item_id]);
    for (const item of report.items) {
      expect(item.reason.split(/\s+/).length).toBeLessThanOrEqual(20);
      expect(item.confidence).toBeGreaterThanOrEqual(0);
      expect(item.confidence).toBeLessThanOrEqual(1);
      expect(Number.isSafeInteger(item.amount_cents) && item.amount_cents >= 0).toBe(true);
      expect([...EXPENSES, "unknown"]).toContain(item.expense);
    }
  });

  it("keeps money in, transfers and ordinary spending out of the items", async () => {
    const report = await classifyDetailed(
      [
        txn("FERNWAY BOOKS PAYROLL", -41200, { kind: "deposit" }),
        txn("Online transfer to savings", 4000, { kind: "transfer" }),
        txn("COPPER KETTLE COFFEE", 650),
        txn("REFUND LOCKSMITH", -1000),
      ],
      ctx,
    );
    expect(report.items).toEqual([]);
    expect(report.all.map((c) => c.method)).toEqual(["income", "transfer", "keyword", "income"]);
  });

  it("leaves rows nothing could sort for the survivor to check", async () => {
    const report = await classifyDetailed(unclear(2), ctx);
    expect(report.items.map((i) => [i.expense, i.confirmed, i.confidence, i.reason])).toEqual([
      ["unknown", false, 0, "Could not sort this one; review it by hand"],
      ["unknown", false, 0, "Could not sort this one; review it by hand"],
    ]);
    expect(report.counts.unresolved).toBe(2);
  });

  it("counts a record listed twice once", async () => {
    const t = txn("CLEARWATER COUNSELING GROUP", 15000);
    const report = await classifyDetailed([t, { ...t }], ctx);
    expect(report.items).toHaveLength(1);
    expect(report.warnings).toContain("A record was listed twice and counted once.");
  });

  it("refuses a date that is not a calendar day", async () => {
    await expect(classifyDetailed([], { st: "MI", incident_date: "06/14/2026" })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("a Tend payment and an itemized bank bill are set aside, and the bill's service date anchors rides", async () => {
    const report = await classifyDetailed(
      [
        txn("Riverbend payment [tend:act-1]", 11800, {
          merchant: "Riverbend General Hospital",
          kind: "withdrawal",
          date: "2026-10-03",
        }),
        txn("Riverbend statement", 44300, {
          merchant: "Riverbend General Hospital",
          kind: "bill",
          itemized: { service_date: "2026-06-14" },
        }),
        txn("trip", 1500, { merchant: "Wayfare Rides", category: "rideshare", kind: "purchase", date: "2026-06-14" }),
      ],
      ctx,
    );
    expect(report.all.map((c) => [c.candidate, c.reason])).toEqual([
      [false, "Payment made through Tend, so the bill lines it paid are reviewed instead"],
      [false, "Itemized statement on file, so its lines are reviewed one by one instead"],
      [true, "Same day as a medical charge"],
    ]);
    expect(report.items).toHaveLength(1);
  });
});

describe("Gemini Nano on the device", () => {
  const answering = (pick: (row: ReturnType<typeof rowsOf>[number]) => string) =>
    new FakeLanguageModel({
      answer: (input) =>
        JSON.stringify({
          results: rowsOf(input).map((r) => ({ ref: r.ref, expense: pick(r), reason: "What it looks like" })),
        }),
    });

  it("sorts what the rules could not, unconfirmed, and never sees amounts", async () => {
    const fake = install(answering(() => "security"));
    const rows = unclear(3);
    const report = await classifyDetailed(rows, ctx);
    expect(report.items.map((i) => [i.expense, i.source, i.confirmed, i.confidence, i.reason])).toEqual(
      Array(3).fill(["security", "device_ai", false, 0.6, "What it looks like"]),
    );
    expect(report.counts.device_ai).toBe(3);
    const prompt = String(fake.prompts[0].input);
    for (const r of rows) {
      expect(prompt).not.toContain(String(r.amount_cents));
      expect(prompt).not.toContain(r.id);
      expect(prompt).not.toContain(r.date);
    }
    expect(Object.keys(rowsOf(prompt)[0]).sort()).toEqual(["category", "description", "kind", "merchant", "ref"]);
  });

  it("constrains the answer to the expense list plus unknown and to this batch's refs", async () => {
    const fake = install(answering(() => "unknown"));
    await classifyDetailed(unclear(2), ctx);
    const schema = fake.prompts[0].options?.responseConstraint as ReturnType<typeof responseSchema> & {
      properties: { results: { items: { properties: { expense: { enum: string[] }; ref: { enum: string[] } } } } };
    };
    expect(schema.properties.results.items.properties.expense.enum).toEqual([...EXPENSES, "unknown"]);
    expect(schema.properties.results.items.properties.ref.enum).toEqual(["t1", "t2"]);
    expect(MODEL_LABELS).toHaveLength(19);
  });

  it("starts the session low-temperature with the classify system prompt", async () => {
    const fake = install(answering(() => "unknown"));
    await classifyDetailed(unclear(1), ctx);
    const created = fake.creates[0] as { samplingMode?: string; initialPrompts?: { role: string; content: string }[] };
    expect(created.samplingMode).toBe("most-predictable");
    expect(created.initialPrompts?.[0].role).toBe("system");
    expect(created.initialPrompts?.[0].content).toMatch(/^You sort bank transactions/);
  });

  it("uses extension sampling controls where the browser still honors them", async () => {
    const fake = new FakeLanguageModel({ answer: () => '{"results":[]}' });
    Object.assign(fake, {
      params: async () => ({ defaultTemperature: 1, maxTemperature: 2, defaultTopK: 3, maxTopK: 8 }),
    });
    install(fake);
    await classifyDetailed(unclear(1), ctx);
    expect(fake.creates[0]).toMatchObject({ temperature: 0.2, topK: 1 });
  });

  it("batches rows and sends each distinct row once", async () => {
    const fake = install(answering(() => "unknown"));
    const rows = unclear(DEVICE_BATCH + 2);
    await classifyDetailed([...rows, ...rows.map((r) => ({ ...r, id: `${r.id}x` }))], ctx);
    expect(fake.prompts.map((p) => rowsOf(p.input).length)).toEqual([DEVICE_BATCH, 2]);
    // One warm session, a fresh clone per batch, each destroyed after use.
    expect(fake.creates).toHaveLength(1);
    expect(fake.destroyed).toBe(2);
  });

  it("ignores answers for other refs and labels outside the list", async () => {
    install(
      new FakeLanguageModel({
        answer: () =>
          JSON.stringify({
            results: [
              { ref: "t1", expense: "luxury_goods", reason: "x" },
              { ref: "t9", expense: "security", reason: "not ours" },
              { ref: "t2", expense: "security", reason: "Door chain, which the state has covered before" },
            ],
          }),
      }),
    );
    const report = await classifyDetailed(unclear(2), ctx);
    expect(report.items.map((i) => [i.expense, i.method, i.reason])).toEqual([
      ["unknown", "unresolved", "Could not sort this one; review it by hand"],
      ["security", "model", "Looks like home security"],
    ]);
  });

  it("gives up on a slow device after two timeouts and says so", async () => {
    const fake = install(new FakeLanguageModel({ delayMs: 200, answer: () => '{"results":[]}' }));
    const report = await classifyDetailed(unclear(DEVICE_BATCH * 3), ctx, { deviceTimeoutMs: 20 });
    expect(fake.prompts).toHaveLength(2);
    expect(report.device.errors).toEqual(["batch 1: timed out", "batch 2: timed out"]);
    expect(report.counts.unresolved).toBe(DEVICE_BATCH * 3);
    expect(report.warnings).toContain(
      "The on-device model could not sort some rows, so they are left for you to check.",
    );
  });

  it("skips a batch whose answer is not JSON and goes on", async () => {
    let call = 0;
    install(
      new FakeLanguageModel({
        answer: (input) =>
          ++call === 1
            ? "Here you go!"
            : JSON.stringify({
                results: rowsOf(input).map((r) => ({ ref: r.ref, expense: "legal", reason: "Legal help" })),
              }),
      }),
    );
    const report = await classifyDetailed(unclear(DEVICE_BATCH + 1), ctx);
    expect(report.counts.unresolved).toBe(DEVICE_BATCH);
    expect(report.counts.device_ai).toBe(1);
  });

  it("does not use a model that still has to download", async () => {
    const fake = install(new FakeLanguageModel({ availability: { text: "downloadable" } }));
    const report = await classifyDetailed(unclear(1), ctx);
    expect(report.device.status).toBe("downloadable");
    expect(fake.creates).toEqual([]);
    expect(report.counts.unresolved).toBe(1);
  });

  it("can be turned off", async () => {
    const fake = install(answering(() => "security"));
    const report = await classifyDetailed(unclear(1), ctx, { deviceAi: false });
    expect(fake.prompts).toEqual([]);
    expect(report.counts.unresolved).toBe(1);
  });

  it("a model's ride guess still waits for a same-day care charge", async () => {
    install(answering(() => "transportation"));
    const report = await classifyDetailed(
      [
        txn("CLEARWATER COUNSELING GROUP", 15000, { date: "2026-06-24" }),
        txn("ODD CAR SERVICE", 1400, { date: "2026-06-24" }),
        txn("ODD CAR SERVICE 2", 900, { date: "2026-06-25" }),
      ],
      ctx,
    );
    expect(report.items.map((i) => [i.expense, i.method, i.confirmed])).toEqual([
      ["counseling", "keyword", true],
      ["transportation", "link", false],
    ]);
  });
});

describe("cloud Gemini only with consent", () => {
  const okFetch = () =>
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { rows: { ref: string }[] };
      return new Response(
        JSON.stringify({
          model: "gemini-cloud",
          results: body.rows.map((r) => ({ ref: r.ref, expense: "childcare", reason: "Child care" })),
        }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    });

  it("never calls the cloud without consent", async () => {
    const fetch = okFetch();
    const report = await classifyDetailed(unclear(2), ctx, { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(report.cloud.used).toBe(false);
    expect(report.counts.unresolved).toBe(2);
  });

  it("sends only kind, merchant, category and description under short refs", async () => {
    const fetch = okFetch();
    const rows = unclear(2);
    const report = await classifyDetailed(rows, ctx, {
      cloudConsent: true,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/ai/classify");
    const sent = JSON.parse(String(init.body));
    expect(Object.keys(sent).sort()).toEqual(["prompt_version", "rows"]);
    expect(sent.rows.map((r: object) => Object.keys(r).sort())).toEqual(
      Array(2).fill(["category", "description", "kind", "merchant", "ref"]),
    );
    const text = String(init.body);
    for (const r of rows)
      for (const secret of [String(r.amount_cents), r.id, r.date]) expect(text).not.toContain(secret);
    expect(report.items.map((i) => [i.expense, i.source, i.confirmed])).toEqual(
      Array(2).fill(["childcare", "cloud_ai", false]),
    );
  });

  it("asks the cloud only about what the device left", async () => {
    install(
      new FakeLanguageModel({
        answer: (input) =>
          JSON.stringify({ results: [{ ref: rowsOf(input)[0].ref, expense: "dental", reason: "Dental care" }] }),
      }),
    );
    const fetch = okFetch();
    const report = await classifyDetailed(unclear(3), ctx, {
      cloudConsent: true,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const sent = JSON.parse(String(fetch.mock.calls[0][1].body));
    expect(sent.rows).toHaveLength(2);
    expect(report.items.map((i) => i.source)).toEqual(["device_ai", "cloud_ai", "cloud_ai"]);
  });

  it("an error from the cloud leaves rows for review", async () => {
    const fetch = vi.fn(async () => new Response("nope", { status: 503 }));
    const report = await classifyDetailed(unclear(1), ctx, {
      cloudConsent: true,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(report.cloud.errors).toEqual(["cloud classification answered 503"]);
    expect(report.counts.unresolved).toBe(1);
    expect(report.warnings).toContain("Cloud sorting did not answer, so some rows are left for you to check.");
  });
});

describe("the demo persona on the device", () => {
  it("rules, links and pay dips together", async () => {
    const { txns } = fromNessieRelay(rowan());
    const report = await classifyDetailed(txns, { st: "MI", incident_date: "2026-06-14" }, { deviceAi: false });
    const by = (e: string) => report.items.filter((i) => i.expense === e);
    expect(by("counseling")).toHaveLength(16);
    expect(by("counseling").every((i) => i.unit === "session" && i.units === 1 && i.confirmed)).toBe(true);
    expect(by("transportation")).toHaveLength(14);
    expect(by("transportation").every((i) => !i.confirmed && i.method === "link")).toBe(true);
    expect(by("lost_wages").map((i) => [i.date, i.amount_cents, i.unit, i.units, i.confirmed])).toEqual([
      ["2026-06-26", 17600, "week", 2, false],
      ["2026-07-10", 17600, "week", 2, false],
      ["2026-07-24", 17600, "week", 2, false],
    ]);
    expect(report.counts).toMatchObject({ rows: 191, pay_dips: 3, unresolved: 4 });
  });

  it("the classifier object follows the shared contract", async () => {
    expect(await classifier.deviceAi()).toBe("unavailable");
    const items = await classifier.classify([txn("CLEARWATER COUNSELING GROUP", 15000)], ctx);
    expect(items).toHaveLength(1);
    expect(await classifier.prewarm()).toBe("unavailable");
  });
});
