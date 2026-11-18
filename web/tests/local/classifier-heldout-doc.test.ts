import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HELDOUT_FILES, type HeldOutResult } from "@/lib/local/heldout";
import {
  dayText,
  DOC_END,
  DOC_START,
  docBlock,
  docBlockIn,
  docFromResults,
  headline,
  modelResults,
  NO_MODEL_RESULT,
  withDocBlock,
} from "@/lib/local/heldout-doc";
import { percent, rateText, wilson } from "@/lib/local/score";

// docs/EVAL.md may say about the held-out rows only what the committed result files hold.
const web = path.resolve(import.meta.dirname, "..", "..");
const dir = path.join(web, "tests", "local", "fixtures");
const doc = readFileSync(path.join(web, "..", "docs", "EVAL.md"), "utf8");
const read = (f: string) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { results: HeldOutResult[] };
const rulesFile = read(HELDOUT_FILES.rules);
const [rules, ceiling] = rulesFile.results;
const modelFiles = readdirSync(dir)
  .filter((f) => /^classifier-heldout\..+\.result\.json$/.test(f) && f !== HELDOUT_FILES.rules)
  .sort();
const models = modelFiles.map((f) => modelResults(f, read(f)));
const s = rules.score;
const flat = doc.replace(/\s+/g, " ");

describe("the held-out numbers in docs/EVAL.md", () => {
  it("holds the block written from the committed result files, to the letter", () => {
    // If this fails, run: npx tsx scripts/classifier-eval.ts --write
    expect(docBlockIn(doc)).toBe(docFromResults(rulesFile, models));
  });

  it("carries the rules-only figure in the classifier table, with what it is and is not", () => {
    const row = doc.split("\n").find((l) => l.startsWith("| Rules only, no model, on"));
    expect(row).toBeDefined();
    expect(row).toContain(`on ${s.rows} held-out rows`);
    expect(row).toContain(headline(rules));
    expect(row).toContain("npx tsx scripts/classifier-eval.ts");
    expect(row).toContain("fictional");
    if (rules.labels.startsWith("proposed")) expect(row).toContain("proposed, not yet reviewed by a person");
    else expect(row).not.toContain("not yet reviewed");
    expect(row).toContain(`first run ${dayText("2026-11-16")}`);
  });

  it("says no model result is committed until a result file for one is", () => {
    const row = doc.split("\n").find((l) => l.startsWith("| Gemini Nano on the same"));
    expect(row).toBeDefined();
    // If a model result is committed, the row has to say what it is: fill it in.
    expect(row!.includes(NO_MODEL_RESULT)).toBe(models.length === 0);
    expect(docBlockIn(doc)!.includes(`Gemini Nano on these rows: ${NO_MODEL_RESULT}.`)).toBe(models.length === 0);
    // The two small sets have no committed run either, and an old figure for them stays out.
    expect(doc).toContain("| Gemini Nano on held-out rows |");
    expect(doc).not.toMatch(/172 of 192/);
    if (!models.length) expect(flat).toContain("There is no accuracy number for Gemini Nano in the repository yet.");
  });

  it("has the same counts in the sentences written by hand", () => {
    const rides = ceiling.score.labels.find((l) => l.label === "transportation")!;
    const prompts = Math.ceil(s.sent.distinct / 6);
    for (const said of [
      `they sort ${s.cost.k} of the ${s.cost.n} cost rows`,
      `no rule matches ${s.sent.rows} of the ${s.rows} rows (${s.sent.distinct} distinct, so ${prompts} prompts of six)`,
      `Of them, ${s.sent.cost} should get a cost label and ${s.sent.none} should get none`,
      `leaves ${rides.rows - rides.right} of the ${rides.rows} rides unoffered`,
      `holds ${s.rows} fictional bank rows`,
    ])
      expect(flat).toContain(said);
    const over = s.overclaim;
    expect(over.before.length + over.checked.length + over.waiting.length).toBe(6); // "The six cost labels given where none belongs"
    expect(s.missed.ruled).toHaveLength(9); // "Nine cost rows are missed by a rule"
    const most = Math.max(...s.labels.filter((l) => l.label !== "unknown").map((l) => l.right));
    expect(flat).toContain(`no label has more than ${most} rows right`);
    for (const label of ["crime_scene_cleanup", "property_replacement", "clothing_bedding", "legal", "other"])
      expect(s.labels.find((l) => l.label === label)!.right).toBe(0);
  });

  it("has no long dash or curly quote in the section", () => {
    const from = doc.indexOf("## Sorting costs (the classifier)");
    const section = doc.slice(from, doc.indexOf("## End to end"));
    expect(section.length).toBeGreaterThan(2000);
    expect(section).not.toMatch(/[\u2012-\u2015\u2018\u2019\u201C\u201D]/);
  });
});

describe("the block", () => {
  const block = docBlock(rules, ceiling, []);

  it("works each rate again from its counts, so it reads as the script prints it", () => {
    expect(block).toContain(`| All rows right | ${rateText(wilson(s.accuracy.k, s.accuracy.n))} |`);
    expect(block).toContain(`| Missed: no cost label where one belongs | ${rateText(wilson(194, 230))} |`);
    expect(block).toContain("84.3% (194 of 230"); // 0.8435 in the file would print as 84.4%
    expect(headline(rules)).toBe("257 of 460 rows right: 55.9% (95% interval 51.3% to 60.3%)");
  });

  it("names the rows behind each kind of mistake", () => {
    expect(block).toContain("| ... on or after the incident date, and starts checked | 4 (h237, h311, h337, h446) |");
    expect(block).toContain("h243 childcare as tuition");
    expect(block).toContain("| Rows still unsorted after the run | 360 | 0 |");
    expect(block).toContain("these labels stay short: `transportation` 4 of 24");
  });

  it("has a line for every label and every way a row was written", () => {
    for (const l of s.labels) {
      const name = l.label === "unknown" ? "no cost label" : `\`${l.label}\``;
      expect(block).toContain(`| ${name} | ${l.rows} | ${l.given} | ${l.right} |`);
    }
    const legal = wilson(0, 12);
    expect(block).toContain(`| \`legal\` | 12 | 0 | 0 | never given | 0.0% (0.0% to ${percent(legal.hi)}) |`);
    expect(block.split("\n").filter((l) => /^\| .* \| \d+\.\d% \(\d+ of \d+, 95% interval/.test(l))).toHaveLength(
      s.groups.length + 6,
    );
    expect(block).toContain("(SQ \\*, TST\\*, PAYPAL \\* and others)"); // a bare star would start italics
  });

  it("says what the labels are, in the words the result carries", () => {
    expect(block).toContain(`The labels are ${rules.labels}.`);
    const reviewed = { ...rules, labels: "reviewed by a person, all 460 rows (3 corrected, 0 left out)" };
    expect(docBlock(reviewed, ceiling, [])).toContain("The labels are reviewed by a person, all 460 rows (3 corrected");
  });

  it("adds a model's runs when a result for it exists, and drops the line that says there is none", () => {
    // The ceiling stands in for a model's result here. It is not one.
    const file = { answers_file: "x.answers.json", model: "gemini-nano", browser: "Chrome/142.0.7444.60" };
    const withModel = docBlock(rules, ceiling, [
      modelResults("classifier-heldout.nano.result.json", { ...file, results: [ceiling, rules] }),
    ]);
    expect(withModel).not.toContain(NO_MODEL_RESULT);
    expect(withModel).toContain(
      "Rules, then recorded answers from `gemini-nano` in Chrome/142.0.7444.60 (`classifier-heldout.nano.result.json`), 2 runs.",
    );
    expect(withModel).toContain("|  | Run 1 | Run 2 |");
    expect(withModel).toContain("Per label, rules then `gemini-nano`, run 1:");
    expect(() => modelResults("empty.result.json", { results: [] })).toThrow("holds no results");
    expect(() => docFromResults({ results: [rules] }, [])).toThrow("the rules-only run and the ceiling");
  });

  it("is put between the marks, and only there", () => {
    const page = `before\n${DOC_START}\nold\n${DOC_END}\nafter\n`;
    const next = withDocBlock(page, block);
    expect(next).toBe(`before\n${block}\nafter\n`);
    expect(withDocBlock(next, block)).toBe(next);
    expect(docBlockIn(next)).toBe(block);
    expect(docBlockIn("no marks")).toBeNull();
    expect(() => withDocBlock("no marks", block)).toThrow("lost the classifier-heldout marks");
  });

  it("writes a day the way the doc does", () => {
    expect(dayText("2026-11-16")).toBe("Nov 16, 2026");
    expect(dayText("2026-01-05")).toBe("Jan 5, 2026");
    expect(() => dayText("Nov 16")).toThrow("is not a day");
    expect(() => dayText("2026-13-01")).toThrow("is not a day");
  });
});
