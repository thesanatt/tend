// The TypeScript classifier against the Python one (api/tend_api/classify.py) on the fictional seed
// snapshots. Rebuild the reference with:
//   uv run --project api python web/scripts/classify-parity.py
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyDetailed } from "@/lib/local/classify";
import { fromNessieRelay } from "@/lib/local/nessie";
import { classifyDeterministic, cleanReason, type Classification, type FactKind } from "@/lib/local/rules";
import parity from "./fixtures/classify-parity.json";
import { FakeLanguageModel, install, rowsOf, uninstall } from "./fake-lm";

const ROOT = path.resolve(import.meta.dirname, "../../..");

type Plain = {
  expense: string;
  candidate: boolean;
  confidence: number;
  method: string;
  reason: string;
  confirmed: boolean;
  linked_refs: string[];
};

const plain = (c: Classification): Plain => ({
  expense: c.expense,
  candidate: c.candidate,
  confidence: c.confidence,
  method: c.method,
  reason: c.reason,
  confirmed: c.confirmed,
  // Python refers to Nessie records by bare id; the device keeps the engine's "nessie:" prefix.
  linked_refs: c.linked_refs.map((r) => r.replace(/^nessie:/, "")),
});

const ITEM_KEYS = [
  "item_id",
  "date",
  "amount_cents",
  "expense",
  "confirmed",
  "is_bill",
  "units",
  "description",
  "confidence",
  "reason",
  "method",
  "linked_item_ids",
] as const;

function pick(item: Record<string, unknown>) {
  return Object.fromEntries(ITEM_KEYS.map((k) => [k, item[k]]));
}

afterEach(() => uninstall());

describe("deterministic rules match the Python module", () => {
  it.each(parity.facts.map((f, i) => [i, f] as const))("case %i", (_, f) => {
    const got = classifyDeterministic({
      ref: "x",
      kind: f.kind as FactKind,
      merchant_name: f.merchant,
      merchant_category: f.category,
      description: f.description,
      date: "",
    });
    expect(got ? plain(got) : null).toEqual(f.result);
  });

  it.each(parity.reasons.map((r, i) => [i, r] as const))("reason %i", (_, r) => {
    expect(cleanReason(r.text, r.label)).toBe(r.out);
  });
});

// The four answers the cloud model gave for the seed's unclear rows, served by a fake Gemini Nano.
function modelFromCache() {
  return new FakeLanguageModel({
    answer: (input) => {
      const results = rowsOf(input).map((row) => {
        const hit = parity.model_answers.find(
          (a) =>
            a.kind === row.kind &&
            a.merchant === row.merchant &&
            a.category === row.category &&
            a.description === row.description.toLowerCase(),
        );
        return { ref: row.ref, expense: hit?.expense ?? "unknown", reason: hit?.reason ?? "" };
      });
      return JSON.stringify({ results });
    },
  });
}

describe.each(parity.personas)("$persona_id", (p) => {
  const raw = readFileSync(path.join(ROOT, p.file));
  const snapshot = JSON.parse(raw.toString("utf8"));
  const ctx = { st: snapshot.meta.jurisdiction, incident_date: snapshot.meta.demo_inputs.incident_date };

  it("is the snapshot the reference was made from", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(p.sha256);
  });

  async function run(snap: unknown, withModel: boolean) {
    if (withModel) install(modelFromCache());
    const { txns, warnings } = fromNessieRelay(snap);
    expect(warnings).toEqual([]);
    return classifyDetailed(txns, ctx, { deviceAi: withModel, payDips: false });
  }

  type Expected = {
    results?: Record<string, Plain>;
    results_delta?: Record<string, Plain>;
    count?: number;
    items: Record<string, unknown>[];
  };
  const base = p.rules_only.results as unknown as Record<string, Plain>;

  // Runs other than the first store only the records whose answer differs from the rules-only run.
  function expectSame(report: Awaited<ReturnType<typeof run>>, expected: Expected) {
    const want = expected.results ?? { ...base, ...expected.results_delta };
    const got = Object.fromEntries(report.all.map((c) => [c.ref.replace(/^nessie:/, ""), plain(c)]));
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
    if (expected.count !== undefined) expect(report.all).toHaveLength(expected.count);
    for (const [ref, w] of Object.entries(want)) expect({ ref, ...got[ref] }).toEqual({ ref, ...w });
    expect(report.items.map((i) => pick(i as unknown as Record<string, unknown>))).toEqual(expected.items.map(pick));
  }

  it("rules only: every record and every item match", async () => {
    const report = await run(snapshot, false);
    expectSame(report, p.rules_only as never);
    expect(report.counts.unresolved).toBe(4);
  });

  it("with the model's answers: matches the committed cache run", async () => {
    const report = await run(snapshot, true);
    expectSame(report, p.with_cache as never);
    expect(report.counts.device_ai).toBe(4);
    expect(
      report.items
        .filter((i) => i.source === "device_ai")
        .map((i) => i.expense)
        .sort(),
    ).toEqual(["clothing_bedding", "security"]);
  });

  it.each(p.scenarios.map((s) => [s.name, s] as const))("scenario %s", async (_, s) => {
    const edited = structuredClone(snapshot);
    edited.transactions.push(...s.add_transactions);
    if (s.drop_documents) edited.meta.documents = [];
    expectSame(await run(edited, false), s as never);
  });
});
