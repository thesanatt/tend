// Scores the cost classifier on the held-out rows in tests/local/fixtures/classifier-heldout.json.
// The rows are fictional. With no flag it runs the rules with no model, as the app does when no model
// is there, and prints accuracy, precision and recall per label, a confusion table, the mistakes that
// would raise a claim, and how many rows no rule matched. No model is called by any form of this.
// usage, from web/:
//   npx tsx scripts/classifier-eval.ts                  rules only
//   npx tsx scripts/classifier-eval.ts --model FILE     scores recorded model answers (the file the page
//                                                       /dev/classifier-eval saves in Chrome)
//   npx tsx scripts/classifier-eval.ts --ceiling        scores a model that never errs: each row no rule
//                                                       matched, answered with its label. Not a model's result.
//   add --write to also rewrite the review CSV and the committed result file for that run
// If tests/local/fixtures/classifier-heldout.reviewed.csv exists, its labels replace the proposed ones.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  ceilingAnswers,
  HELDOUT_FILES,
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
} from "../lib/local/heldout";
import { rateText, reportText, score } from "../lib/local/score";

const DIR = join(__dirname, "..", "tests", "local", "fixtures");
const args = process.argv.slice(2);
const write = args.includes("--write");
const ceilingOnly = args.includes("--ceiling");
const CEILING = "rules, then every row a model is asked about answered with its label (a ceiling, not a model)";
const modelAt = args.indexOf("--model");
const modelFile = modelAt >= 0 ? args[modelAt + 1] : null;

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// Keeps a result file as it is when its numbers have not changed, so its date stays the day they were made.
function save(path: string, next: { results: HeldOutResult[] } & Record<string, unknown>) {
  if (existsSync(path)) {
    const old = JSON.parse(readFileSync(path, "utf8")) as { results?: HeldOutResult[] };
    const same =
      old.results?.length === next.results.length && old.results.every((r, i) => sameResult(r, next.results[i]));
    if (same) return console.log(`unchanged: ${path}`);
  }
  writeFileSync(path, json(next));
  console.log(`wrote: ${path}`);
}

// tsx runs this file as CommonJS, where await needs a function around it.
void (async () => {
  if (modelAt >= 0 && !modelFile) throw new Error("--model needs a file");
  const set = JSON.parse(readFileSync(join(DIR, HELDOUT_FILES.set), "utf8")) as HeldOutSet;
  const reviewedPath = join(DIR, HELDOUT_FILES.reviewed);
  const review = existsSync(reviewedPath) ? readReview(readFileSync(reviewedPath, "utf8"), set) : null;

  console.log(`Set: ${HELDOUT_FILES.set}, ${set.rows.length} fictional rows (set hash ${setHash(set)})`);
  console.log(`Labels: ${labelStatus(set, review)}`);
  if (review?.changed.length)
    console.log(`  corrected: ${review.changed.map((c) => `${c.id} ${c.from} -> ${c.to}`).join(", ")}`);

  if (!modelFile) {
    const run = await runHeldOut(set, { review });
    const top = await runHeldOut(set, { answers: ceilingAnswers(set, review), review });
    const topScore = score(top.rows);
    if (ceilingOnly) {
      console.log(`Run: ${CEILING}\n`);
      console.log(reportText(topScore));
    } else {
      console.log("Run: rules only, no model\n");
      console.log(reportText(score(run.rows)));
      if (run.added_lines.length)
        console.log(`\nLines the pay step added that are not rows, so not scored: ${run.added_lines.join(", ")}`);
      console.log(
        `\nCeiling, if a model answered every row it is asked about with the row's label: ${rateText(topScore.accuracy)}`,
      );
      console.log(`  rows with a cost label: ${rateText(topScore.cost)}. See --ceiling for the rest.`);
    }
    if (write) {
      console.log("");
      writeFileSync(join(DIR, HELDOUT_FILES.review), reviewCsv(set));
      console.log(`wrote: ${join(DIR, HELDOUT_FILES.review)}`);
      save(join(DIR, HELDOUT_FILES.rules), {
        results: [
          resultRecord(set, run, { run: "rules only", measured: today(), review }),
          resultRecord(set, top, { run: CEILING, measured: today(), review }),
        ],
      });
    }
    return;
  }

  const raw = JSON.parse(readFileSync(modelFile, "utf8")) as Record<string, unknown>;
  const file = parseAnswers(raw);
  const name = typeof raw.model === "string" ? raw.model : "a model";
  if (typeof raw.set_hash === "string" && raw.set_hash !== setHash(set))
    throw new Error(`these answers were made from other rows (set hash ${raw.set_hash}); run the page again`);
  const results: HeldOutResult[] = [];
  for (const [i, answers] of file.runs.entries()) {
    const run = await runHeldOut(set, { answers: answers.answers, review });
    console.log(
      `\nRun ${i + 1} of ${file.runs.length}: rules, then recorded answers from ${name} (${basename(modelFile)})`,
    );
    console.log(
      `Rows asked: ${run.model!.asked}; with a recorded answer: ${run.model!.answered}; ` +
        `answers not used because a rule now sorts the row: ${run.model!.unused.length}\n`,
    );
    console.log(reportText(score(run.rows)));
    results.push(resultRecord(set, run, { run: `rules, then ${name}`, measured: today(), review }));
  }
  if (write) {
    console.log("");
    const about = Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "runs" && k !== "answers"));
    save(modelFile.replace(/\.answers\.json$|\.json$/, ".result.json"), {
      answers_file: basename(modelFile),
      ...about,
      results,
    });
  }
})().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
