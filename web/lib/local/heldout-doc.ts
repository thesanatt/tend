// The part of docs/EVAL.md that holds the held-out rows' numbers. It is written from the committed
// result files, so the doc cannot say a figure they do not hold. A test compares the two.
import type { HeldOutResult } from "./heldout";
import { NO_COST, percent, rateText, wilson, type Rate, type Score } from "./score";

export const DOC_START = "<!-- classifier-heldout:start -->";
export const DOC_END = "<!-- classifier-heldout:end -->";
// What the doc says about a model until a result file for it is committed.
export const NO_MODEL_RESULT = "no result is committed";

// A model's result file: what the page recorded about the run, and one result for each run.
export interface ModelResults {
  file: string;
  model: string;
  browser?: string;
  results: HeldOutResult[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-11-16" as "Nov 16, 2026", the way the doc writes a day.
export function dayText(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m || !MONTHS[Number(m[2]) - 1]) throw new Error(`"${iso}" is not a day`);
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

// The result files keep each rate to four places. Working it again from the two counts gives the
// same text the script prints, with no second rounding.
const exact = (r: Rate) => wilson(r.k, r.n);
const rate = (r: Rate) => rateText(exact(r));

// The one line the table at the top of the classifier section carries for a run.
export function headline(result: HeldOutResult): string {
  const r = exact(result.score.accuracy);
  return `${r.k} of ${r.n} rows right: ${percent(r.p)} (95% interval ${percent(r.lo)} to ${percent(r.hi)})`;
}

const listed = (ids: string[]) => (ids.length ? `${ids.length} (${ids.join(", ")})` : "0");
const name = (label: string) => (label === NO_COST ? "no cost label" : `\`${label}\``);
const range = (r: Rate, none: string) => {
  const x = exact(r);
  return x.n === 0 ? none : `${percent(x.p)} (${percent(x.lo)} to ${percent(x.hi)})`;
};
// A star or a bar in a cell would be read as markdown.
export const plain = (text: string) => text.replace(/([*|])/g, "\\$1");
export const table = (head: string[], rows: string[][]) => [
  `| ${head.join(" | ")} |`,
  `|${head.map(() => "---").join("|")}|`,
  ...rows.map((r) => `| ${r.join(" | ")} |`),
];

// One line a measure, one column a run.
function measures(runs: { title: string; result: HeldOutResult }[]): string[] {
  const row = (label: string, cell: (s: Score) => string) => [label, ...runs.map((r) => cell(r.result.score))];
  return table(
    ["", ...runs.map((r) => r.title)],
    [
      ["Measured", ...runs.map((r) => dayText(r.result.measured))],
      row("All rows right", (s) => rate(s.accuracy)),
      row("Rows that should get a cost label, right", (s) => rate(s.cost)),
      row("Rows that should get none, right", (s) => rate(s.none)),
      row("Rows a rule decided, right", (s) => rate(s.ruled)),
      row("Would raise a claim: a cost label where none belongs", (s) => rate(s.overclaim.rate)),
      row("... on or after the incident date, and starts checked", (s) => listed(s.overclaim.checked)),
      row("... on or after it, and waits for an answer", (s) => listed(s.overclaim.waiting)),
      row("... dated before it, which the law engine leaves out", (s) => listed(s.overclaim.before)),
      row("Missed: no cost label where one belongs", (s) => rate(s.missed.rate)),
      row("... no rule matched the row", (s) => String(s.missed.sent.length)),
      row("... a rule called it ordinary spending, or a ride had no care that day", (s) => listed(s.missed.ruled)),
      row("One cost label where another belongs", (s) =>
        listed(s.swapped.map((w) => `${w.id} ${w.expect} as ${w.got}`)),
      ),
      row(
        "Rows no rule matched, which are all a model is asked about",
        (s) => `${s.sent.rows} (${s.sent.distinct} distinct)`,
      ),
      row("... of those, should get a cost label", (s) => String(s.sent.cost)),
      row("... of those, should get none", (s) => String(s.sent.none)),
      row("Rows still unsorted after the run", (s) => String(s.sent.left)),
    ],
  );
}

function perLabel(s: Score): string[] {
  return table(
    ["Label", "Rows", "Given", "Right", "Precision", "Recall"],
    s.labels.map((l) => [
      name(l.label),
      String(l.rows),
      String(l.given),
      String(l.right),
      range(l.precision, "never given"),
      range(l.recall, "no rows"),
    ]),
  );
}

// The labels a run did not get right on every row, fewest right first.
const short = (s: Score) =>
  s.labels
    .filter((l) => l.label !== NO_COST && l.right < l.rows)
    .sort((a, b) => a.right / a.rows - b.right / b.rows)
    .map((l) => `${name(l.label)} ${l.right} of ${l.rows}`)
    .join(", ");

export function docBlock(rules: HeldOutResult, ceiling: HeldOutResult, models: ModelResults[]): string {
  const s = rules.score;
  const out: string[] = [DOC_START];
  out.push(
    "<!-- Written by `cd web && npx tsx scripts/classifier-eval.ts --write` from the result files in",
    "     web/tests/local/fixtures. Change a number by running that, not by editing between these marks. -->",
    "",
    `The rows: ${s.rows} fictional rows from \`${rules.set}\` (set hash \`${rules.set_hash}\`). ${s.cost.n} should get a ` +
      `cost label and ${s.none.n} should get none. The labels are ${rules.labels}. ` +
      `The rows' writer flagged ${s.unsure.rows} of them as unsure; ${s.unsure.wrong} of the ${s.wrong} rows the ` +
      "rules got wrong are flagged.",
    "",
  );
  out.push(
    ...measures([
      { title: "Rules only, no model", result: rules },
      {
        title: "A model that never errs. This is a ceiling worked out from the labels, not a model's result",
        result: ceiling,
      },
    ]),
    "",
  );
  if (ceiling.score.labels.some((l) => l.label !== NO_COST && l.right < l.rows))
    out.push(`Even with a model that never errs, these labels stay short: ${short(ceiling.score)}.`, "");

  if (!models.length) out.push(`Gemini Nano on these rows: ${NO_MODEL_RESULT}.`, "");
  for (const m of models) {
    const runs = m.results.map((result, i) => ({ title: `Run ${i + 1}`, result }));
    out.push(
      `Rules, then recorded answers from \`${m.model}\`${m.browser ? ` in ${m.browser}` : ""} (\`${m.file}\`), ` +
        `${runs.length === 1 ? "one run" : `${runs.length} runs`}. Labels: ${m.results[0].labels}.`,
      "",
      ...measures(runs),
      "",
      `Per label, rules then \`${m.model}\`, run 1:`,
      "",
      ...perLabel(m.results[0].score),
      "",
    );
  }

  out.push(
    "Per label, rules only. Precision is the share of rows given the label that carry it. Recall is the share of " +
      "rows carrying the label that were given it. Each range is the 95% interval.",
    "",
    ...perLabel(s),
    "",
    "By how the row was written, rules only:",
    "",
    ...table(
      ["How the row was written", "Right"],
      s.groups.map((g) => [plain(g.group), rate(g.rate)]),
    ),
  );
  if (rules.added_lines.length)
    out.push("", `Lines the pay step added that are not rows, so not scored: ${rules.added_lines.join(", ")}.`);
  out.push(DOC_END);
  return out.join("\n");
}

// The doc with the block between the marks replaced.
export function withDocBlock(doc: string, block: string): string {
  const start = doc.indexOf(DOC_START);
  const end = doc.indexOf(DOC_END);
  if (start < 0 || end < start) throw new Error("docs/EVAL.md has lost the classifier-heldout marks");
  return doc.slice(0, start) + block + doc.slice(end + DOC_END.length);
}

export function docBlockIn(doc: string): string | null {
  const start = doc.indexOf(DOC_START);
  const end = doc.indexOf(DOC_END);
  return start < 0 || end < start ? null : doc.slice(start, end + DOC_END.length);
}

// A model's result file as the script saved it, read back for the doc.
export function modelResults(file: string, json: unknown): ModelResults {
  const j = json as { model?: unknown; browser?: unknown; results?: HeldOutResult[] };
  if (!Array.isArray(j.results) || !j.results.length) throw new Error(`${file} holds no results`);
  return {
    file,
    model: typeof j.model === "string" ? j.model : "a model",
    ...(typeof j.browser === "string" ? { browser: j.browser } : {}),
    results: j.results,
  };
}

// The block from the rules result file (the rules-only run, then the ceiling) and any model result files.
export function docFromResults(rulesFile: { results?: HeldOutResult[] }, models: ModelResults[]): string {
  const [rules, ceiling] = rulesFile.results ?? [];
  if (!rules || !ceiling) throw new Error("the rules result file should hold the rules-only run and the ceiling");
  return docBlock(rules, ceiling, models);
}
