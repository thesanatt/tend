// Compares the second labeling pass over the held-out rows (tests/local/fixtures/
// classifier-heldout.second-pass.json) with the labels the rows' writer proposed, and counts the
// rules-only run against each. Both sets of labels were made by AI models: this is not a person's
// review, and it does not turn any figure into accuracy. No model is called.
// usage, from web/:
//   npx tsx scripts/classifier-second-pass.ts            prints the comparison
//   npx tsx scripts/classifier-second-pass.ts --write    also saves the counts and rewrites the block
//                                                        of them in docs/EVAL.md
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HELDOUT_FILES, runHeldOut, type HeldOutSet } from "../lib/local/heldout";
import {
  agreement,
  readSecondPass,
  sameAgreement,
  SECOND_PASS_FILES,
  secondDocBlock,
  withSecondBlock,
  type Agreement,
} from "../lib/local/second-pass";
import { rateText, wilson } from "../lib/local/score";

const DIR = join(__dirname, "..", "tests", "local", "fixtures");
const DOC = join(__dirname, "..", "..", "docs", "EVAL.md");
const write = process.argv.slice(2).includes("--write");

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const read = (f: string) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as unknown;
const rate = (c: { k: number; n: number }) => rateText(wilson(c.k, c.n));

// tsx runs this file as CommonJS, where await needs a function around it.
void (async () => {
  const set = read(HELDOUT_FILES.set) as HeldOutSet;
  const second = readSecondPass(read(SECOND_PASS_FILES.labels), set);
  // The proposed labels are the ones in the set. A person's review, if there is one, is not used here.
  const ruled = (await runHeldOut(set)).rows;
  let a = agreement(set, second, ruled, today());

  const path = join(DIR, SECOND_PASS_FILES.agreement);
  const old = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Agreement) : null;
  // The day stays the day the numbers were made when they have not changed.
  if (old && sameAgreement(old, a)) a = old;

  console.log(`Second pass: ${a.labeler}, labeled ${a.labeled}. ${a.not_a_review}`);
  console.log(`Same label: ${rate(a.same)}`);
  console.log(`  leaving out the ${a.seen.length} rows whose proposed labels it had seen: ${rate(a.same_unseen)}`);
  console.log(`Cohen's kappa: ${a.kappa.toFixed(4)}`);
  console.log(`Flagged unsure: writer ${a.unsure.writer}, second pass ${a.unsure.second}, both ${a.unsure.both}`);
  console.log(`Labeled differently: ${a.differ.length}`);
  for (const d of a.differ)
    console.log(`  ${d.id} ${d.date} ${d.description}: proposed ${d.proposed}, second pass ${d.second}`);
  console.log("Rules only, counted against:");
  console.log(`  the proposed labels: ${rate(a.rules.proposed.all)}`);
  console.log(`  the second pass: ${rate(a.rules.second.all)}`);
  console.log(`  only the rows both label the same: ${rate(a.rules.agreed.all)}`);

  if (!write) return;
  console.log("");
  if (old === a) console.log(`unchanged: ${path}`);
  else {
    writeFileSync(path, `${JSON.stringify(a, null, 2)}\n`);
    console.log(`wrote: ${path}`);
  }
  const doc = readFileSync(DOC, "utf8");
  const next = withSecondBlock(doc, secondDocBlock(a));
  if (next === doc) return console.log(`unchanged: ${DOC}`);
  writeFileSync(DOC, next);
  console.log(`wrote: ${DOC} (the block of second pass numbers)`);
})().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
