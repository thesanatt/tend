import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifier,
  classifyDetailed,
  DEVICE_BATCH,
  modelLabel,
  REFUND_REASON,
  refundedPurchases,
  responseSchema,
} from "@/lib/local/classify";
import { CLOUD_LIMITS, scrubForCloud } from "@/lib/local/cloud";
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

  it("never takes a forensic exam or lost pay from a model", async () => {
    // Seen in Chrome 154: Gemini Nano labeled a phone bill payment lost_wages.
    install(answering((row) => (row.description.endsWith("A") ? "forensic_exam" : "lost_wages")));
    const report = await classifyDetailed(unclear(2), ctx);
    expect(report.all.map((c) => [c.expense, c.candidate, c.confirmed, c.reason])).toEqual([
      ["medical", true, false, "Looks like medical care"],
      ["unknown", false, false, "Looks like ordinary spending"],
    ]);
    expect(report.items.map((i) => i.expense)).toEqual(["medical"]);
    expect(modelLabel("security")).toBe("security");
  });

  it("the same guard applies to cloud answers", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { txns: { id: string }[] };
      const labels = body.txns.map((t) => ({ id: t.id, expense: "forensic_exam", method: "model", reason: "Exam" }));
      return new Response(JSON.stringify({ model_ok: true, cloud_used: true, labels }), {
        headers: { "content-type": "application/json" },
      });
    });
    const report = await classifyDetailed(unclear(1), ctx, {
      cloudConsent: true,
      deviceAi: false,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(report.items.map((i) => [i.expense, i.source])).toEqual([["medical", "cloud_ai"]]);
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

  it("a very long description reaches the model cut short, and the rows after it still get sorted", async () => {
    const lengths: number[] = [];
    install(
      new FakeLanguageModel({
        answer: (input) => {
          const rows = rowsOf(input);
          lengths.push(...rows.map((r) => Array.from(r.description).length));
          return JSON.stringify({ results: rows.map((r) => ({ ref: r.ref, expense: "legal", reason: "Legal help" })) });
        },
      }),
    );
    const report = await classifyDetailed([txn(`ODD SHOP ${"x".repeat(10_000)}`, 1000), ...unclear(DEVICE_BATCH)], ctx);
    expect(Math.max(...lengths)).toBe(CLOUD_LIMITS.description);
    expect(report.counts.device_ai).toBe(DEVICE_BATCH + 1);
  });

  it("a device whose sessions never come back cannot hang a scan", async () => {
    const fake = new FakeLanguageModel();
    fake.create = async () => ({
      prompt: async () => "{}",
      clone: () => new Promise<never>(() => undefined),
      destroy: () => undefined,
    });
    install(fake);
    const report = await classifyDetailed(unclear(DEVICE_BATCH * 3), ctx, { deviceTimeoutMs: 20 });
    expect(report.device.errors).toEqual(["batch 1: timed out", "batch 2: timed out"]);
    expect(report.counts.unresolved).toBe(DEVICE_BATCH * 3);
  });
});

describe("refunds", () => {
  const sessions = (refund: Partial<LocalTxn>) => [
    txn("CLEARWATER COUNSELING GROUP", 15000, { date: "2026-06-17", kind: "purchase" }),
    txn("CLEARWATER COUNSELING GROUP", 15000, { date: "2026-06-24", kind: "purchase" }),
    txn("CLEARWATER COUNSELING GROUP REFUND", -15000, { date: "2026-06-26", kind: "deposit", ...refund }),
  ];

  it("a cost whose same amount came back from the same place is asked about, not pre-checked", async () => {
    const report = await classifyDetailed(sessions({}), ctx, { deviceAi: false });
    expect(report.items.map((i) => [i.date, i.amount_cents, i.confirmed, i.reason])).toEqual([
      ["2026-06-17", 15000, true, "Counseling or therapy charge"],
      ["2026-06-24", 15000, false, REFUND_REASON],
    ]);
  });

  it.each([
    ["another amount", { amount_cents: -5000 }],
    ["another merchant", { description: "ODD SHOP REFUND" }],
    ["money that came before the charge", { date: "2026-06-10" }],
    ["more than 90 days later", { date: "2026-10-01" }],
    ["a transfer", { kind: "transfer" as const }],
  ])("%s is not a refund of it", async (_, refund) => {
    const report = await classifyDetailed(sessions(refund), ctx, { deviceAi: false });
    expect(report.items.every((i) => i.confirmed)).toBe(true);
  });

  it("one deposit answers for one charge", () => {
    const two = [...sessions({}), txn("CLEARWATER COUNSELING GROUP", -15000, { date: "2026-06-27", kind: "deposit" })];
    expect(refundedPurchases(two).size).toBe(2);
    expect(refundedPurchases(sessions({})).size).toBe(1);
  });
});

describe("what leaves the device for cloud sorting", () => {
  it.each([
    ["Zelle payment to Jane Doe JPM99abc123", "Zelle payment to a person"],
    ["ZELLE FROM DOE JANE ON 06/14 REF # PP0ABC123", "ZELLE FROM a person"],
    ["Venmo *jdoe", "Venmo payment"],
    ["PAYPAL *LUMEN STREAM 4029357733 CA", "PAYPAL *LUMEN STREAM CA"],
    ["WEB ID: 3264681992 VENMO CASHOUT", "WEB VENMO CASHOUT"],
    ["CHECKCARD 0614 ODD SHOP XXXXXXXXXXXX4321", "CHECKCARD ODD SHOP"],
    ["ODD SHOP #1043 ACCT 556677", "ODD SHOP"],
    ["Odd Shop (734) 555-0199 2026-06-14", "Odd Shop"],
    ["Odd Shop Route 66, 24 hour service", "Odd Shop Route 66, 24 hour service"],
  ])("%s", (input, out) => {
    expect(scrubForCloud(input)).toBe(out);
  });
});

describe("cloud Gemini only with consent", () => {
  // The answer shape of POST /api/ai/classify: one label per row; the model's are method "model".
  const label = (id: string, method = "model") => ({
    id,
    expense: method === "model" ? "childcare" : "unknown",
    candidate: true,
    confirmed: false,
    confidence: 0.6,
    method,
    source: method === "model" ? "cloud_ai" : "rule",
    reason: "Child care",
    unit: null,
    units: 0,
    tags: [],
  });
  const reply = (body: object) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const okFetch = (method = "model") =>
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { txns: { id: string }[] };
      return reply({
        source: "cloud_ai",
        model: "gemini-cloud",
        model_ok: true,
        labels: body.txns.map((t) => label(t.id, method)),
        items: [],
        note: null,
      });
    });
  const asFetch = (f: unknown) => f as typeof globalThis.fetch;

  it("never calls the cloud without consent", async () => {
    const fetch = okFetch();
    const report = await classifyDetailed(unclear(2), ctx, { fetch: asFetch(fetch) });
    expect(fetch).not.toHaveBeenCalled();
    expect(report.cloud.used).toBe(false);
    expect(report.counts.unresolved).toBe(2);
  });

  it("sends consent and, per row, only kind, merchant, category and description under a short ref", async () => {
    const fetch = okFetch();
    const rows = unclear(2);
    const report = await classifyDetailed(rows, ctx, { cloudConsent: true, fetch: asFetch(fetch) });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/ai/classify");
    const sent = JSON.parse(String(init.body));
    expect(Object.keys(sent).sort()).toEqual(["consent", "txns"]);
    expect(sent.consent).toBe(true);
    expect(sent.txns.map((r: object) => Object.keys(r).sort())).toEqual(
      Array(2).fill(["category", "description", "id", "kind", "merchant"]),
    );
    expect(sent.txns.map((r: { id: string }) => r.id)).toEqual(["t1", "t2"]);
    const text = String(init.body);
    for (const r of rows)
      for (const secret of [String(r.amount_cents), r.id, r.date]) expect(text).not.toContain(secret);
    expect(report.items.map((i) => [i.expense, i.source, i.confirmed])).toEqual(
      Array(2).fill(["childcare", "cloud_ai", false]),
    );
  });

  it("takes card numbers, dates, amounts, contact details and other people's names out first", async () => {
    const fetch = okFetch();
    const rows = [
      txn("ZELLE TO DOE JANE ON 06/14 REF # PP0ABC1234", 4000),
      txn("CASH APP*JANE DOE*OAKLAND CA", 2500),
      txn("Zelle Transfer Conf# T0ABC; Jane Doe", 3000),
      txn("UTILITY CO DES:BILL PAY ID:XXXXX12345 INDN:JANE DOE CO ID:1234567890 PPD", 5100),
      txn("ACH DEBIT ORIG CO NAME:CITY WATER IND NAME:JANE DOE TRN: 1234TC", 6100),
      txn("ODD SHOP 4111 1111 1111 1234 $45.10 CALL 415-555-0100 jdoe@example.com", 4510),
      txn("PURCHASE AUTHORIZED ON 06/18 NORTHSIDE HARDWARE ANN ARBOR MI S386169734567890 CARD 1234", 6400),
    ];
    await classifyDetailed(rows, ctx, { cloudConsent: true, deviceAi: false, fetch: asFetch(fetch) });
    const sent = JSON.parse(String(fetch.mock.calls[0][1].body)) as { txns: { description: string }[] };
    expect(sent.txns.map((t) => t.description)).toEqual([
      "ZELLE TO a person",
      "CASH APP payment",
      "Zelle Transfer",
      "UTILITY CO DES:BILL PAY",
      "ACH DEBIT ORIG CO NAME:CITY WATER",
      "ODD SHOP CALL",
      "PURCHASE AUTHORIZED ON NORTHSIDE HARDWARE ANN ARBOR MI",
    ]);
    const text = String(fetch.mock.calls[0][1].body);
    for (const secret of ["JANE", "Jane", "DOE", "1234", "06/1", "45.10", "555", "@", "PP0ABC", "T0ABC"])
      expect(text).not.toContain(secret);
  });

  it("keeps every field inside the API's limits, counted in characters as Python counts them", async () => {
    const fetch = okFetch();
    const long = (c: string, n: number) => Array(n).fill(c).join("");
    const row = txn(long("\u{1F33F}", 500), 1000, { merchant: long("\u{1F33F}", 300), category: long("e", 100) });
    await classifyDetailed([row], ctx, { cloudConsent: true, deviceAi: false, fetch: asFetch(fetch) });
    const [sent] = (JSON.parse(String(fetch.mock.calls[0][1].body)) as { txns: Record<string, string>[] }).txns;
    expect([sent.merchant, sent.category, sent.description].map((s) => Array.from(s).length)).toEqual([
      CLOUD_LIMITS.merchant,
      CLOUD_LIMITS.category,
      CLOUD_LIMITS.description,
    ]);
    // Cut between characters, never inside one: no half of a surrogate pair is left behind.
    expect(sent.description.length).toBe(2 * CLOUD_LIMITS.description);
  });

  it("says so when the server has no cloud model and sorts nothing", async () => {
    // What POST /api/ai/classify answers when cloud AI is off on the server: rules only.
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { txns: { id: string }[] };
      return reply({
        source: "cloud_ai",
        model: null,
        cloud_used: false,
        model_ok: true,
        labels: body.txns.map((t) => label(t.id, "unresolved")),
        items: [],
        note: null,
      });
    });
    const report = await classifyDetailed(unclear(2), ctx, {
      cloudConsent: true,
      deviceAi: false,
      fetch: asFetch(fetch),
    });
    expect(report.counts.unresolved).toBe(2);
    expect(report.cloud.errors).toEqual(["cloud model is not set up on the server"]);
    expect(report.warnings).toContain("Cloud sorting did not answer, so some rows are left for you to check.");
  });

  it("takes only the model's labels from the answer", async () => {
    const report = await classifyDetailed(unclear(1), ctx, {
      cloudConsent: true,
      fetch: asFetch(okFetch("unresolved")),
    });
    expect(report.counts.unresolved).toBe(1);
  });

  it("still reads the older {results} answer", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { txns: { id: string }[] };
      return reply({ results: body.txns.map((t) => ({ ref: t.id, expense: "legal", reason: "Legal help" })) });
    });
    const report = await classifyDetailed(unclear(1), ctx, { cloudConsent: true, fetch: asFetch(fetch) });
    expect(report.items[0]).toMatchObject({ expense: "legal", source: "cloud_ai" });
  });

  it("asks the cloud only about what the device left", async () => {
    install(
      new FakeLanguageModel({
        answer: (input) =>
          JSON.stringify({ results: [{ ref: rowsOf(input)[0].ref, expense: "dental", reason: "Dental care" }] }),
      }),
    );
    const fetch = okFetch();
    const report = await classifyDetailed(unclear(3), ctx, { cloudConsent: true, fetch: asFetch(fetch) });
    const sent = JSON.parse(String(fetch.mock.calls[0][1].body));
    expect(sent.txns).toHaveLength(2);
    expect(report.items.map((i) => i.source)).toEqual(["device_ai", "cloud_ai", "cloud_ai"]);
  });

  it("an error from the cloud leaves rows for review", async () => {
    const fetch = vi.fn(async () => new Response("nope", { status: 503 }));
    const report = await classifyDetailed(unclear(1), ctx, { cloudConsent: true, fetch: asFetch(fetch) });
    expect(report.cloud.errors).toEqual(["cloud classify answered 503"]);
    expect(report.counts.unresolved).toBe(1);
    expect(report.warnings).toContain("Cloud sorting did not answer, so some rows are left for you to check.");
  });

  it("a cloud model that did not answer is reported, not guessed", async () => {
    const fetch = vi.fn(async () =>
      reply({ model: null, model_ok: false, labels: [label("t1", "unresolved")], note: "Cloud AI did not answer." }),
    );
    const report = await classifyDetailed(unclear(1), ctx, { cloudConsent: true, fetch: asFetch(fetch) });
    expect(report.cloud.errors).toEqual(["Cloud AI did not answer."]);
    expect(report.counts.unresolved).toBe(1);
  });
});

describe("item shape (SPEC v1.2 units and tags, as the API sets them)", () => {
  it("lodging counts the nights it names; counseling is one session; property gets the law's tags", async () => {
    const report = await classifyDetailed(
      [
        txn("DOWNTOWN HOTEL 2 nights", 27800),
        txn("SAFE STAY MOTEL", 9900),
        txn("BRIGHTLINE WIRELESS NEW PHONE", 29900),
        txn("GADGET HUB NEW LAPTOP", 89900),
        txn("CLEARWATER COUNSELING GROUP", 15000),
      ],
      ctx,
    );
    expect(report.items.map((i) => [i.expense, i.unit, i.units, i.tags])).toEqual([
      ["temporary_housing", "day", 2, []],
      ["temporary_housing", "day", 0, []],
      ["property_replacement", null, 0, ["phone"]],
      ["property_replacement", null, 0, []],
      ["counseling", "session", 1, []],
    ]);
  });

  it("a bank bill for counseling holds an unknown number of sessions", async () => {
    const report = await classifyDetailed(
      [txn("statement", 60000, { merchant: "Clearwater Counseling Group", kind: "bill" })],
      ctx,
    );
    expect(report.items[0]).toMatchObject({ unit: "session", units: 0, is_bill: true });
  });

  it("the relay's flag sets a Tend payment aside even when its tag was stripped", async () => {
    const report = await classifyDetailed(
      [txn("Riverbend General Hospital payment", 11800, { kind: "withdrawal", tend_payment: true })],
      ctx,
    );
    expect(report.items).toEqual([]);
    expect(report.all[0].reason).toMatch(/^Payment made through Tend/);
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
    expect(by("lost_wages").map((i) => [i.date, i.amount_cents, i.unit, i.units, i.confirmed, i.reason])).toEqual([
      ["2026-06-26", 17600, "week", 2, false, "Paycheck was $236, $176 below your usual $412"],
      ["2026-07-10", 17600, "week", 2, false, "Paycheck was $236, $176 below your usual $412"],
      ["2026-07-24", 17600, "week", 2, false, "Paycheck was $236, $176 below your usual $412"],
    ]);
    // Lost pay sits on the short deposit's own record, as the API's wage gaps do.
    for (const item of by("lost_wages")) {
      expect(txns.find((t) => t.id === item.item_id)?.kind).toBe("deposit");
      expect(report.all.find((c) => c.ref === item.item_id)).toMatchObject({
        expense: "lost_wages",
        method: "inference",
        candidate: true,
      });
    }
    expect(report.counts).toMatchObject({ rows: 191, pay_dips: 3, unresolved: 4 });
  });

  it("the classifier object follows the shared contract", async () => {
    expect(await classifier.deviceAi()).toBe("unavailable");
    const items = await classifier.classify([txn("CLEARWATER COUNSELING GROUP", 15000)], ctx);
    expect(items).toHaveLength(1);
    expect(await classifier.prewarm()).toBe("unavailable");
  });
});
