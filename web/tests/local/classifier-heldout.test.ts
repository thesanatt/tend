import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEVICE_EXAMPLES } from "@/lib/local/classify";
import {
  ceilingAnswers,
  checkSet,
  HELDOUT_FILES,
  heldOutTxns,
  labelStatus,
  parseAnswers,
  readReview,
  resultRecord,
  reviewCsv,
  runHeldOut,
  sameResult,
  setHash,
  type HeldOutResult,
  type HeldOutSet,
} from "@/lib/local/heldout";
import { score } from "@/lib/local/score";
import { EXPENSES } from "@/lib/types";
import raw from "./fixtures/classifier-heldout.json";
import evalA from "./fixtures/device-eval.json";
import evalB from "./fixtures/device-eval-b.json";
import { FakeLanguageModel, install, uninstall } from "./fake-lm";

afterEach(() => uninstall());

const set = raw as HeldOutSet;
const dir = path.join(__dirname, "fixtures");
const read = (name: string) => readFileSync(path.join(dir, name), "utf8");
const byId = new Map(set.rows.map((r) => [r.id, r]));
const REWRITE = "run `npx tsx scripts/classifier-eval.ts --write` in web/ and commit what it changes";

// A person's copy of the review file, when there is one. The script reads the same file.
const review = existsSync(path.join(dir, HELDOUT_FILES.reviewed))
  ? readReview(read(HELDOUT_FILES.reviewed), set)
  : null;

describe("the held-out rows", () => {
  it("have one id each, a label from the list, and a line on how each was written", () => {
    expect(() => checkSet(set)).not.toThrow();
    expect(new Set(set.rows.map((r) => r.id)).size).toBe(set.rows.length);
    for (const r of set.rows) {
      expect(r.id).toMatch(/^h\d{3}$/);
      expect(r.date).toMatch(/^2026-\d{2}-\d{2}$/);
      expect(Number.isInteger(r.amount_cents) && r.amount_cents !== 0, r.id).toBe(true);
      expect(`${r.merchant}${r.description}`.trim(), r.id).not.toBe("");
      expect(r.source.length, r.id).toBeGreaterThan(10);
    }
    expect(set.notice).toContain("No row comes from a real statement or a real person");
    expect(set.notice).toContain("proposed and has not been checked by a person");
    expect(set.label_policy!.length).toBeGreaterThan(0);
  });

  it("cover every label, with as many rows that should get no label as rows that should get one", () => {
    const count = (label: string) => set.rows.filter((r) => r.expect === label).length;
    for (const label of EXPENSES) expect(count(label), label).toBeGreaterThanOrEqual(5);
    expect(count("unknown")).toBe(230);
    expect(set.rows.length).toBe(460);
  });

  // The rows a classifier is most tempted to count. Each should get no cost label.
  it.each([
    ["a phone bill payment", "h227", /cricket wireless/i],
    ["a phone bill by ACH", "h403", /T-MOBILE/],
    ["person-to-person cash with no memo", "h082", /^APPLE PAY CASH$/],
    ["a gym", "h016", /PLANET FITNESS/],
    ["a pet clinic", "h237", /PET HOSPITAL/],
    ["a pet clinic through a card reader", "h046", /VET/],
    ["a pharmacy chain selling groceries", "h258", /CVS.*milk, bread/],
    ["a ride on a day with no care visit", "h004", /UBER/],
    ["a dental insurance premium", "h072", /DELTA DENTAL.*PREMIUM/],
  ])("hold %s as a row with no cost", (_, id, words) => {
    const r = byId.get(id)!;
    expect(`${r.merchant} ${r.description}`.trim()).toMatch(words);
    expect(r.expect).toBe("unknown");
  });

  it("share no row with the examples the model is shown, or with the two small device sets", () => {
    const shown = JSON.parse(DEVICE_EXAMPLES[0].content.slice(DEVICE_EXAMPLES[0].content.indexOf("\n") + 1)) as {
      merchant: string;
      description: string;
    }[];
    const key = (m: string, d: string) => `${m.toLowerCase()}|${d.toLowerCase()}`;
    const other = [...shown, ...evalA.rows, ...evalB.rows];
    const taken = new Set(other.map((r) => key(r.merchant, r.description)));
    const merchants = new Set(other.map((r) => r.merchant.toLowerCase()).filter(Boolean));
    for (const r of set.rows) {
      expect(taken.has(key(r.merchant, r.description)), r.id).toBe(false);
      expect(merchants.has(r.merchant.toLowerCase()), r.id).toBe(false);
      for (const m of merchants) expect(r.description.toLowerCase().includes(m), `${r.id} ${m}`).toBe(false);
    }
  });

  it("become statement rows the way a bank file does, with the kind read from the words", () => {
    const txns = heldOutTxns(set.rows);
    expect(txns).toHaveLength(set.rows.length);
    expect(txns.every((t) => t.origin === "csv")).toBe(true);
    const kinds = new Set(txns.map((t) => t.kind));
    expect([...kinds].sort()).toEqual(["deposit", "purchase", "transfer", "withdrawal"]);
  });
});

describe("the review file", () => {
  const csv = reviewCsv(set);

  it("is the committed file, one line a row with the reviewed column empty", () => {
    expect(read(HELDOUT_FILES.review), REWRITE).toBe(csv);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("id,date,money_out,description,merchant,category,proposed,reviewed,source,note");
    expect(lines).toHaveLength(set.rows.length + 1);
    expect(lines[82]).toBe(
      'h082,2026-03-08,40.00,APPLE PAY CASH,,,unknown,,"person-to-person payment line (Zelle, Venmo, Cash App, Apple Cash), some with a memo","peer-to-peer cash, no memo"',
    );
  });

  it("reads back as a file nobody has looked at yet", () => {
    const r = readReview(csv, set);
    expect([r.labels.size, r.skipped.size, r.changed.length, r.blank]).toEqual([0, 0, 0, set.rows.length]);
    expect(labelStatus(set, r)).toBe("proposed by the rows' writer, not reviewed by a person");
    expect(labelStatus(set, null)).toBe("proposed by the rows' writer, not reviewed by a person");
  });

  it("takes ok, a label, none and skip, and counts an empty cell as not looked at", () => {
    const text = [
      "﻿reviewed,ID,description,extra",
      'ok,h001,"STARBUCKS, STORE",x',
      "Medical,h237,,",
      "none,h225,,",
      "skip,h106,,",
      ",h002,,",
      "temporary housing,h319,,",
      " Yes ,h004,,",
    ].join("\r\n");
    const r = readReview(text, set);
    expect(Object.fromEntries(r.labels)).toEqual({
      h001: "unknown",
      h237: "medical",
      h225: "unknown",
      h319: "temporary_housing",
      h004: "unknown",
    });
    expect([...r.skipped]).toEqual(["h106"]);
    expect(r.changed).toEqual([
      { id: "h237", from: "unknown", to: "medical" },
      { id: "h225", from: "forensic_exam", to: "unknown" },
      { id: "h319", from: "unknown", to: "temporary_housing" },
    ]);
    expect(r.blank).toBe(set.rows.length - 6); // h002, and every row the file leaves out
    expect(labelStatus(set, r)).toBe(
      "partly reviewed by a person, 6 of 460 rows (3 corrected, 1 left out); the rest are proposed",
    );
  });

  it("says so when every row has been looked at", () => {
    const filled = ["id,reviewed", ...set.rows.map((r) => `${r.id},ok`)].join("\n");
    const r = readReview(filled, set);
    expect(r.labels.size).toBe(set.rows.length);
    expect(labelStatus(set, r)).toBe("reviewed by a person, all 460 rows (0 corrected, 0 left out)");
  });

  it("refuses a file it cannot line up with the rows", () => {
    expect(() => readReview("id,label\nh001,ok", set)).toThrow('needs "id" and "reviewed" columns');
    expect(() => readReview("id,reviewed\nh999,ok", set)).toThrow('line 2: "h999" is not a row id in the set');
    expect(() => readReview("id,reviewed\nh001,ok\nh001,ok", set)).toThrow("line 3: row h001 is listed twice");
    expect(() => readReview("id,reviewed\nh001,rent", set)).toThrow(
      'line 2: "rent" is not a label. Use ok, skip, none',
    );
  });
});

describe("the rules-only run", () => {
  const committed = JSON.parse(read(HELDOUT_FILES.rules)) as { results: HeldOutResult[] };

  it("gives the numbers in the committed result file", async () => {
    const [rules, ceiling] = committed.results;
    expect(committed.results).toHaveLength(2);
    expect(rules.set_hash, REWRITE).toBe(setHash(set));

    const run = await runHeldOut(set, { review });
    expect(run.model).toBeUndefined();
    const now = resultRecord(set, run, { run: "rules only", measured: rules.measured, review });
    expect(now.score.accuracy, REWRITE).toEqual(rules.score.accuracy);
    expect(sameResult(now, rules), REWRITE).toBe(true);

    const top = await runHeldOut(set, { answers: ceilingAnswers(set, review), review });
    expect(sameResult(resultRecord(set, top, { run: ceiling.run, measured: ceiling.measured, review }), ceiling)).toBe(
      true,
    );
    expect(ceiling.run).toContain("not a model");
  });

  it("says in the file what the rows and labels are", () => {
    for (const r of committed.results) {
      expect(r.rows_are).toContain("fictional");
      expect(r.rows_are).toContain("not a sample of real statements");
      expect(r.labels).toBe(labelStatus(set, review));
      expect(r.measured).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("calls no model, and scores what a person is offered", async () => {
    const fake = install(new FakeLanguageModel());
    const run = await runHeldOut(set);
    expect(fake.prompts).toHaveLength(0);
    expect(run.report.device.used).toBe(false);
    expect(run.rows).toHaveLength(set.rows.length);
    // a pet hospital the keyword "hospital" takes for care: offered and checked, so it is scored as medical
    expect(run.rows.find((r) => r.id === "h237")).toMatchObject({ got: "medical", sent: false, confirmed: true });
    // a row no rule matched is offered with no label
    expect(run.rows.find((r) => r.id === "h001")).toMatchObject({ got: "unknown", sent: true, method: "unresolved" });
    expect(run.rows.filter((r) => r.sent)).toHaveLength(run.report.counts.unresolved);
  });

  it("scores against a reviewer's labels, and leaves out the rows they skipped", async () => {
    const before = score((await runHeldOut(set)).rows);
    const mine = readReview("id,reviewed\nh237,medical\nh001,skip\nh002,ok", set);
    const run = await runHeldOut(set, { review: mine });
    const after = score(run.rows);
    expect(run.rows).toHaveLength(set.rows.length - 1);
    expect(run.rows.find((r) => r.id === "h237")!.expect).toBe("medical");
    // h001 was right and is gone; h237 was wrong and is now right
    expect([after.accuracy.k, after.accuracy.n]).toEqual([before.accuracy.k, before.accuracy.n - 1]);
    expect(after.overclaim.rate.k).toBe(before.overclaim.rate.k - 1);
  });

  it("refuses a set with a repeated id or a label that is not on the list", async () => {
    const twice = { ...set, rows: [set.rows[0], set.rows[0]] };
    await expect(runHeldOut(twice)).rejects.toThrow("row id h001 is listed twice");
    const odd = { ...set, rows: [{ ...set.rows[0], expect: "coffee" }] };
    await expect(runHeldOut(odd)).rejects.toThrow('row h001: "coffee" is not a label');
  });
});

describe("scoring recorded model answers", () => {
  it("asks about the rows no rule matched and no others", async () => {
    const run = await runHeldOut(set, { answers: {} });
    expect(run.model).toMatchObject({ asked: 360, answered: 0, unused: [] });
    expect(run.model!.missing).toHaveLength(360);
    // with no answers, the result is the rules-only one
    expect(score(run.rows)).toEqual(score((await runHeldOut(set)).rows));
  });

  it("puts each answer through the app's own steps", async () => {
    const run = await runHeldOut(set, {
      answers: {
        h001: "medical", // a coffee shop, wrongly called care
        h106: "forensic_exam", // code never takes this label from a model
        h225: "lost_wages", // nor this one
        h003: "unknown",
        h237: "dental", // a rule already sorted this row, so the answer is not used
      },
    });
    const got = (id: string) => run.rows.find((r) => r.id === id)!;
    expect(got("h001")).toMatchObject({ got: "medical", method: "model", confirmed: false });
    expect(got("h106").got).toBe("medical");
    expect(got("h225").got).toBe("unknown");
    expect(got("h237").got).toBe("medical");
    expect(run.model!.unused).toEqual(["h237"]);
    // h003 and h206 read the same, so one answer covers both
    expect(got("h206")).toMatchObject({ got: "unknown", method: "model" });
    expect(run.model!.answered).toBe(5);
    const s = score(run.rows);
    expect(s.overclaim.before).toContain("h001"); // dated in January, before the incident date
    expect(s.swapped).toContainEqual({ id: "h106", expect: "forensic_exam", got: "medical" });
  });

  it("offers a ride a model named only on a day with a care charge a rule sorted", async () => {
    // Fourteen rows read "UBER *TRIP HELP.UBER.COM CA". One answer covers them all.
    const run = await runHeldOut(set, { answers: { h004: "transportation" } });
    const rides = run.rows.filter((r) => r.key === run.rows.find((x) => x.id === "h004")!.key);
    expect(rides).toHaveLength(14);
    expect(rides.filter((r) => r.expect === "unknown").every((r) => r.got === "unknown")).toBe(true);
    for (const r of rides.filter((x) => x.got === "transportation")) expect(r.method).toBe("link");
  });

  it("refuses answers it cannot line up with the rows", async () => {
    await expect(runHeldOut(set, { answers: { h999: "medical" } })).rejects.toThrow(
      "row h999, which is not in the set",
    );
    await expect(runHeldOut(set, { answers: { h001: "coffee" } })).rejects.toThrow('"coffee" is not a label');
    await expect(runHeldOut(set, { answers: { h003: "medical", h206: "unknown" } })).rejects.toThrow(
      "rows h003 and h206 read the same but have different answers",
    );
  });

  it("puts back whatever model the page had", async () => {
    const holder = globalThis as { LanguageModel?: unknown };
    await runHeldOut(set, { answers: { h001: "unknown" } });
    expect("LanguageModel" in holder).toBe(false);
    const fake = install(new FakeLanguageModel());
    await runHeldOut(set, { answers: { h001: "unknown" } });
    expect(holder.LanguageModel).toBe(fake);
    expect(fake.prompts).toHaveLength(0);
    await expect(runHeldOut(set, { answers: { h999: "medical" } })).rejects.toThrow();
    expect(holder.LanguageModel).toBe(fake);
  });

  it("reads the three shapes an answers file can have", () => {
    const saved = { model: "gemini-nano", runs: [{ ms: 5, answers: { h001: "unknown" } }, { answers: {} }] };
    expect(parseAnswers(saved)).toEqual(saved);
    expect(parseAnswers({ answers: { h001: "medical" } }).runs).toEqual([{ answers: { h001: "medical" } }]);
    expect(parseAnswers({ h001: "medical", h002: { expense: "unknown", reason: "x" } }).runs).toEqual([
      { answers: { h001: "medical", h002: "unknown" } },
    ]);
    expect(() => parseAnswers({ h001: 3 })).toThrow("answer for h001 has no label");
    expect(() => parseAnswers({ runs: [{ answers: ["medical"] }] })).toThrow("answers must be a map");
  });

  it("has a fresh result file beside every committed answers file", async () => {
    const files = readdirSync(dir).filter((f) => /^classifier-heldout\..+\.answers\.json$/.test(f));
    for (const f of files) {
      const answers = JSON.parse(read(f)) as { set_hash?: string; model?: string };
      const resultFile = f.replace(/\.answers\.json$/, ".result.json");
      const how = `run \`npx tsx scripts/classifier-eval.ts --model tests/local/fixtures/${f} --write\` in web/`;
      expect(existsSync(path.join(dir, resultFile)), how).toBe(true);
      expect(answers.set_hash, `${f} was made from other rows`).toBe(setHash(set));
      const saved = JSON.parse(read(resultFile)) as { results: HeldOutResult[] };
      const runs = parseAnswers(answers).runs;
      expect(saved.results, how).toHaveLength(runs.length);
      for (const [i, r] of runs.entries()) {
        const run = await runHeldOut(set, { answers: r.answers, review });
        const now = resultRecord(set, run, { run: saved.results[i].run, measured: saved.results[i].measured, review });
        expect(sameResult(now, saved.results[i]), how).toBe(true);
      }
    }
  });
});

describe("the ceiling", () => {
  const top = ceilingAnswers(set);

  it("answers every row no rule matched with its label, one answer for rows that read the same", async () => {
    const run = await runHeldOut(set, { answers: top });
    expect(run.model).toMatchObject({ asked: 360, answered: 360, unused: [], missing: [] });
    const keyOf = new Map(run.rows.map((r) => [r.id, r.key]));
    const differs = set.rows.filter((r) => top[r.id] !== undefined && top[r.id] !== r.expect);
    // every row whose answer is not its own label shares its words with a row that carries that label
    for (const r of differs) {
      const twin = set.rows.find((o) => keyOf.get(o.id) === keyOf.get(r.id) && o.expect === top[r.id]);
      expect(twin, r.id).toBeDefined();
    }
    expect(differs.length).toBeLessThan(20);
  });

  it("is not beaten by any other answer for a group of rows that read the same", async () => {
    const base = await runHeldOut(set, { answers: top });
    const best = score(base.rows).accuracy.k;
    const groups = new Map<string, string[]>();
    for (const r of base.rows.filter((x) => x.sent)) groups.set(r.key, [...(groups.get(r.key) ?? []), r.id]);
    let tried = 0;
    for (const ids of groups.values()) {
      const labels = new Set(ids.map((id) => byId.get(id)!.expect));
      if (labels.size < 2) continue;
      for (const label of labels) {
        if (label === top[ids[0]]) continue;
        const answers = { ...top, ...Object.fromEntries(ids.map((id) => [id, label])) };
        const run = await runHeldOut(set, { answers });
        expect(score(run.rows).accuracy.k, `${ids[0]} as ${label}`).toBeLessThanOrEqual(best);
        tried++;
      }
    }
    expect(tried).toBeGreaterThan(0);
  });

  it("adds no mistake that raises a claim, and cannot give back the two barred labels", async () => {
    const rules = score((await runHeldOut(set)).rows);
    const s = score((await runHeldOut(set, { answers: top })).rows);
    expect(s.overclaim.rate.k).toBe(rules.overclaim.rate.k);
    expect(s.cost.k).toBeGreaterThan(rules.cost.k);
    expect(s.cost.k).toBeLessThanOrEqual(rules.cost.k + rules.sent.cost - rules.sent.barred);
    expect(s.sent.left).toBe(0);
  });
});
