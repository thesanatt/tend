import { afterEach, describe, expect, it } from "vitest";
import { DEVICE_EXAMPLES } from "@/lib/local/classify";
import { measureDeviceClassifier } from "@/lib/local/measure";
import { classifyDeterministic, MODEL_LABELS } from "@/lib/local/rules";
import evalA from "./fixtures/device-eval.json";
import evalB from "./fixtures/device-eval-b.json";
import { FakeLanguageModel, install, rowsOf, uninstall } from "./fake-lm";

afterEach(() => uninstall());

const examples = JSON.parse(DEVICE_EXAMPLES[0].content.slice(DEVICE_EXAMPLES[0].content.indexOf("\n") + 1)) as {
  merchant: string;
  description: string;
}[];
const answers = (JSON.parse(DEVICE_EXAMPLES[1].content) as { results: { expense: string }[] }).results;

describe("device evaluation sets", () => {
  it.each([
    ["A", evalA.rows],
    ["B", evalB.rows],
  ])("set %s: every row is fictional work for the model, not the rules", (_, rows) => {
    for (const r of rows) {
      expect(MODEL_LABELS).toContain(r.expect);
      const hit = classifyDeterministic({
        ref: "x",
        kind: "purchase",
        merchant_name: r.merchant,
        merchant_category: r.category,
        description: r.description,
        date: "",
      });
      expect(hit, `${r.merchant} / ${r.description}`).toBeNull();
    }
  });

  it("the worked examples share no row with either evaluation set", () => {
    const key = (m: string, d: string) => `${m.toLowerCase()}|${d.toLowerCase()}`;
    const evalKeys = new Set([...evalA.rows, ...evalB.rows].map((r) => key(r.merchant, r.description)));
    const merchants = new Set([...evalA.rows, ...evalB.rows].map((r) => r.merchant.toLowerCase()));
    for (const e of examples) {
      expect(evalKeys.has(key(e.merchant, e.description))).toBe(false);
      expect(merchants.has(e.merchant.toLowerCase())).toBe(false);
    }
    expect(answers.every((a) => MODEL_LABELS.includes(a.expense))).toBe(true);
    expect(answers).toHaveLength(examples.length);
  });
});

describe("measureDeviceClassifier", () => {
  it("scores the model's labels against the expected ones", async () => {
    install(
      new FakeLanguageModel({
        answer: (input) =>
          JSON.stringify({
            results: rowsOf(input).map((r) => ({
              ref: r.ref,
              expense: r.description === "vitamins" ? "prescription" : "unknown",
              reason: "x",
            })),
          }),
      }),
    );
    const rows = evalA.rows.slice(0, 4);
    const [run] = await measureDeviceClassifier(rows, { runs: 1 });
    const expected = rows.filter(
      (r) => (r.description === "vitamins" ? "prescription" : "unknown") === r.expect,
    ).length;
    expect(run).toMatchObject({ total: 4, correct: expected, errors: [] });
    expect(run.wrong.some((w) => w.startsWith("Corner Drug / vitamins: prescription"))).toBe(true);
  });

  it("can run without the worked examples, for comparison", async () => {
    const fake = install(new FakeLanguageModel({ answer: () => '{"results":[]}' }));
    await measureDeviceClassifier(evalA.rows.slice(0, 1), { runs: 1, examples: false });
    await measureDeviceClassifier(evalA.rows.slice(0, 1), { runs: 1 });
    const prompts = fake.creates.map((c) => (c as { initialPrompts: unknown[] }).initialPrompts.length);
    expect(prompts).toEqual([1, 3]);
  });
});
