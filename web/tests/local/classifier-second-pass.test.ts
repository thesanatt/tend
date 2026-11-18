import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HELDOUT_FILES,
  readReview,
  runHeldOut,
  setHash,
  type HeldOutResult,
  type HeldOutSet,
} from "@/lib/local/heldout";
import type { ScoredRow } from "@/lib/local/score";
import {
  agreement,
  NOT_A_REVIEW,
  readSecondPass,
  sameAgreement,
  SECOND_END,
  SECOND_PASS_FILES,
  SECOND_START,
  secondBlockIn,
  secondDocBlock,
  withSecondBlock,
  type Agreement,
  type SecondPass,
} from "@/lib/local/second-pass";
import raw from "./fixtures/classifier-heldout.json";

// The second labeling pass over the held-out rows was made by a model. These checks hold three
// things in place: the labels stay the ones that were fixed before the comparison, the numbers in
// docs/EVAL.md are the ones the files give, and nothing can take the pass for a person's review.
const web = path.resolve(import.meta.dirname, "..", "..");
const dir = path.join(web, "tests", "local", "fixtures");
const text = (f: string) => readFileSync(path.join(dir, f), "utf8");
const set = raw as HeldOutSet;
const labelsText = text(SECOND_PASS_FILES.labels);
const second = readSecondPass(JSON.parse(labelsText), set);
const committed = JSON.parse(text(SECOND_PASS_FILES.agreement)) as Agreement;
const doc = readFileSync(path.join(web, "..", "docs", "EVAL.md"), "utf8");
const flat = doc.replace(/\s+/g, " ");
const REWRITE = "run `npx tsx scripts/classifier-second-pass.ts --write` in web/ and commit what it changes";

const copy = (change: (p: SecondPass) => void): unknown => {
  const p = JSON.parse(labelsText) as SecondPass;
  change(p);
  return p;
};

describe("the second pass file", () => {
  it("labels every row in the set once", () => {
    expect(second.rows).toHaveLength(set.rows.length);
    expect(second.rows.map((r) => r.id)).toEqual(set.rows.map((r) => r.id));
    expect(second.set_hash).toBe(setHash(set));
  });

  it("holds the labels that were fixed before the comparison", () => {
    // If this fails, a label or an unsure flag was edited after the two passes were compared. That is
    // a new pass: it needs its own file and notice, not an edit to this one.
    const print = createHash("sha256")
      .update(second.rows.map((r) => `${r.id}:${r.label}:${r.unsure ? "u" : ""}`).join("\n"))
      .digest("hex");
    expect(print).toBe("9b2c39f3bf2bf513e50459e89c91e97d08bcd77a458200be8c5c1789c8505406");
  });

  it("says who made it, and what the labeler had seen", () => {
    expect(second.notice).toContain("by an AI model");
    expect(second.notice).toContain("It is not a person's review");
    expect(second.notice).toContain("It was not fully blind");
    expect(second.notice).toContain("a mistake the two share does not show up as a difference");
    expect(second.notice).toContain(`the ${set.rows.length} rows`);
    expect(second.seen).toHaveLength(5); // "the five rows listed in seen"
    const writerUnsure = set.rows.filter((r) => (r.note ?? "").startsWith("unsure")).length;
    expect(second.notice).toContain(`that ${writerUnsure} rows were flagged unsure`);
  });

  it("is plain ASCII", () => {
    expect(labelsText).not.toMatch(/[^\x00-\x7F]/);
  });

  it("cannot be read as a person's review, or as a result or a model's answers", () => {
    expect(() => readReview(labelsText, set)).toThrow('the review file needs "id" and "reviewed" columns');
    for (const name of Object.values(SECOND_PASS_FILES)) {
      expect(name).not.toBe(HELDOUT_FILES.reviewed);
      // classifier-eval.ts and the held-out tests pick up fixtures by these two patterns.
      expect(name).not.toMatch(/^classifier-heldout\..+\.result\.json$/);
      expect(name).not.toMatch(/^classifier-heldout\..+\.answers\.json$/);
    }
  });

  it("is not read by the script that scores the classifier", () => {
    for (const file of ["scripts/classifier-eval.ts", "lib/local/heldout.ts", "lib/local/heldout-doc.ts"])
      expect(readFileSync(path.join(web, file), "utf8")).not.toMatch(/second.pass/i);
  });
});

describe("reading a second pass file", () => {
  it("refuses a file made from other rows", () => {
    expect(() =>
      readSecondPass(
        copy((p) => (p.set_hash = "0000000000000000")),
        set,
      ),
    ).toThrow("made from other rows");
  });

  it("refuses a missing row, a row listed twice, and a row that is not in the set", () => {
    expect(() =>
      readSecondPass(
        copy((p) => p.rows.pop()),
        set,
      ),
    ).toThrow(`the second pass has no label for ${set.rows.at(-1)!.id}`);
    expect(() =>
      readSecondPass(
        copy((p) => p.rows.push({ ...p.rows[0] })),
        set,
      ),
    ).toThrow(`second pass row ${set.rows[0].id} is listed twice`);
    expect(() =>
      readSecondPass(
        copy((p) => (p.rows[0].id = "h999")),
        set,
      ),
    ).toThrow("second pass row h999 is not in the set");
    expect(() =>
      readSecondPass(
        copy((p) => p.seen.push("h999")),
        set,
      ),
    ).toThrow("seen row h999 is not in the set");
  });

  it("refuses a label that is not one of the labels, and a file with no notice", () => {
    expect(() =>
      readSecondPass(
        copy((p) => (p.rows[0].label = "groceries")),
        set,
      ),
    ).toThrow('"groceries" is not a label');
    expect(() =>
      readSecondPass(
        copy((p) => (p.notice = "")),
        set,
      ),
    ).toThrow('the second pass file needs "notice"');
  });
});

describe("the comparison", () => {
  it("is the committed counts, worked out again from the two sets of labels", async () => {
    const ruled = (await runHeldOut(set)).rows;
    const again = agreement(set, second, ruled, committed.measured);
    expect(sameAgreement(again, committed), REWRITE).toBe(true);
    expect(again).toEqual(committed);
  });

  it("adds up", () => {
    const a = committed;
    expect(a.same.n).toBe(set.rows.length);
    expect(a.same.k + a.differ.length).toBe(a.same.n);
    expect(a.same_unseen.n).toBe(a.same.n - a.seen.length);
    for (const r of [a.rules.proposed, a.rules.second, a.rules.agreed]) {
      expect(r.cost.k + r.none.k).toBe(r.all.k);
      expect(r.cost.n + r.none.n).toBe(r.all.n);
    }
    expect(a.rules.proposed.cost.n).toBe(a.cost_rows.proposed);
    expect(a.rules.second.cost.n).toBe(a.cost_rows.second);
    expect(a.rules.agreed.all.n).toBe(a.same.k);
    expect(a.unsure.both).toBeLessThanOrEqual(Math.min(a.unsure.writer, a.unsure.second));
    expect(a.not_a_review).toBe(NOT_A_REVIEW);
    for (const d of a.differ) expect(d.proposed).not.toBe(d.second);
  });

  it("counts the rules-only run against the proposed labels as the committed result does", () => {
    const { results } = JSON.parse(text(HELDOUT_FILES.rules)) as { results: HeldOutResult[] };
    const s = results[0].score;
    // Once a person's review is committed the result is scored against their labels, not these.
    if (!results[0].labels.startsWith("proposed")) return;
    expect(committed.rules.proposed.all).toEqual({ k: s.accuracy.k, n: s.accuracy.n });
    expect(committed.rules.proposed.cost).toEqual({ k: s.cost.k, n: s.cost.n });
  });

  it("works out kappa and the three counts on four rows by hand", () => {
    const row = (id: string, expect: string, note?: string) => ({
      id,
      date: "2026-04-01",
      amount_cents: 1000,
      merchant: "",
      category: "",
      description: `ROW ${id}`,
      expect,
      source: "plain",
      note,
    });
    const mini: HeldOutSet = {
      context: set.context,
      rows: [
        row("a", "medical"),
        row("b", "medical", "unsure: could be either"),
        row("c", "unknown"),
        row("d", "unknown"),
      ],
    };
    const pass: SecondPass = {
      notice: "four rows",
      labeler: "a test",
      labeled: "2026-11-18",
      set_hash: setHash(mini),
      seen: ["a"],
      rows: [
        { id: "a", label: "medical" },
        { id: "b", label: "unknown", unsure: true, note: "no sign of care" },
        { id: "c", label: "unknown", unsure: true },
        { id: "d", label: "unknown" },
      ],
    };
    const got = { a: "medical", b: "unknown", c: "unknown", d: "medical" };
    const ruled = Object.entries(got).map(([id, g]) => ({ id, got: g }) as ScoredRow);
    const a = agreement(mini, readSecondPass(pass, mini), ruled, "2026-11-18");
    expect(a.same).toEqual({ k: 3, n: 4 });
    expect(a.same_unseen).toEqual({ k: 2, n: 3 });
    // Chance: medical 2/4 x 1/4, no label 2/4 x 3/4, so 0.5. Kappa is (0.75 - 0.5) / (1 - 0.5).
    expect(a.kappa).toBe(0.5);
    expect(a.cost_rows).toEqual({ proposed: 2, second: 1 });
    expect(a.unsure).toEqual({ writer: 1, second: 2, both: 1 });
    expect(a.differ.map((d) => [d.id, d.proposed, d.second, d.second_note])).toEqual([
      ["b", "medical", "unknown", "unsure: no sign of care"],
    ]);
    expect(a.rules.proposed).toEqual({ all: { k: 2, n: 4 }, cost: { k: 1, n: 2 }, none: { k: 1, n: 2 } });
    expect(a.rules.second).toEqual({ all: { k: 3, n: 4 }, cost: { k: 1, n: 1 }, none: { k: 2, n: 3 } });
    expect(a.rules.agreed).toEqual({ all: { k: 2, n: 3 }, cost: { k: 1, n: 1 }, none: { k: 1, n: 2 } });
    expect(() => agreement(mini, pass, ruled.slice(1), "2026-11-18")).toThrow("the rules run has no row a");
    expect(sameAgreement(a, { ...a, measured: "2027-01-01" })).toBe(true);
    expect(sameAgreement(a, { ...a, kappa: 0.6 })).toBe(false);
  });
});

describe("the second pass in docs/EVAL.md", () => {
  const a = committed;
  const from = doc.indexOf("#### A second model pass over the labels");
  const section = doc.slice(from, doc.indexOf("## End to end"));

  it("holds the block written from the committed counts, to the letter", () => {
    expect(from).toBeGreaterThan(0);
    expect(secondBlockIn(doc), REWRITE).toBe(secondDocBlock(a));
  });

  it("opens by saying it is not a person's review, and closes by saying no person has checked the labels", () => {
    const body = section.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    expect(body[0].startsWith("This is not a person's review.")).toBe(true);
    expect(body.at(-1)).toBe(
      "So every figure in this section is still agreement with labels that no person has checked.",
    );
    expect(secondBlockIn(doc)).toContain(NOT_A_REVIEW);
    expect(section).not.toMatch(/\baccura(te|cy) of\b/i);
  });

  it("has the same counts in the sentences written by hand", () => {
    const { results } = JSON.parse(text(HELDOUT_FILES.rules)) as { results: HeldOutResult[] };
    const p = a.rules.proposed.all;
    const s = a.rules.second.all;
    for (const said of [
      `labeled all ${a.same.n} rows again`,
      `the two passes give the same label to ${a.same.k} of the ${a.same.n} rows`,
      `the rules-only figure is ${p.k} of ${p.n} against the proposed labels and ${s.k} of ${s.n} against the second pass`,
      `that ${a.unsure.writer} rows were flagged unsure, and the proposed labels of ${a.seen.length} rows`,
      `The writer flagged ${a.unsure.writer} rows as unsure and the second pass flagged ${a.unsure.second}, and only ${a.unsure.both} rows are flagged by both`,
      `The ${a.differ.length} rows the second pass labels differently (${a.differ.map((d) => d.id).join(", ")}, listed in the last part of this section)`,
    ])
      expect(flat).toContain(said);
    if (results[0].labels.startsWith("proposed"))
      expect(flat).toContain(`The ${results[0].score.wrong} rows the rules got wrong`);
  });

  it("carries the comparison in the classifier table as a model pass", () => {
    const row = doc.split("\n").find((l) => l.startsWith("| The 460 rows labeled a second time"));
    expect(row).toBeDefined();
    expect(row).toContain("by a second AI model");
    expect(row).toContain(`on ${a.same.k} of ${a.same.n} rows`);
    expect(row).toContain("not a person's review");
    expect(row).toContain("npx tsx scripts/classifier-second-pass.ts");
  });

  it("is plain ASCII between its marks", () => {
    expect(secondBlockIn(doc)).not.toMatch(/[^\x00-\x7F]/);
    expect(section).not.toMatch(/[^\x00-\x7F]/);
  });

  it("puts a new block between the marks and leaves the rest alone", () => {
    const page = `before\n${SECOND_START}\nold\n${SECOND_END}\nafter\n`;
    const next = withSecondBlock(page, secondDocBlock(a));
    expect(next.startsWith("before\n")).toBe(true);
    expect(next.endsWith("\nafter\n")).toBe(true);
    expect(secondBlockIn(next)).toBe(secondDocBlock(a));
    expect(withSecondBlock(next, secondDocBlock(a))).toBe(next);
    expect(() => withSecondBlock("no marks here", "x")).toThrow("lost the classifier-second-pass marks");
    expect(secondBlockIn("no marks here")).toBeNull();
  });

  it("leaves out the table of rows when the two passes agree on every row", () => {
    const none = secondDocBlock({ ...a, differ: [], same: { k: a.same.n, n: a.same.n } });
    expect(none).toContain("| Rows labeled differently | 0 |");
    expect(none).not.toContain("the first ones for a person to settle");
  });
});
