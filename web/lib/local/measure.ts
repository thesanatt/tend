// Measures the on-device classifier in a real browser: accuracy against labeled rows and time
// per run. Used with tests/local/fixtures/device-eval*.json from a dev page or the console; the
// rows are fictional and nothing leaves the device.
import { classifyDetailed, toFacts } from "./classify";
import { heldOutTxns, type HeldOutSet } from "./heldout";
import { classifyDeterministic } from "./rules";
import type { LocalTxn } from "./types";

export interface EvalRow {
  merchant: string;
  category: string;
  description: string;
  expect: string;
}

export interface EvalRun {
  ms: number;
  correct: number;
  total: number;
  batches: number;
  errors: string[];
  wrong: string[];
}

export async function measureDeviceClassifier(
  rows: EvalRow[],
  opts: { runs?: number; examples?: boolean } = {},
): Promise<EvalRun[]> {
  const txns: LocalTxn[] = rows.map((r, i) => ({
    id: `eval:${i}`,
    // Spread over days with no care charge, so no ride is linked and each label stands alone.
    date: `2026-07-${String(1 + (i % 28)).padStart(2, "0")}`,
    amount_cents: 1000 + i,
    description: r.description,
    merchant: r.merchant,
    category: r.category,
    origin: "csv",
    kind: "purchase",
  }));
  const runs: EvalRun[] = [];
  for (let k = 0; k < (opts.runs ?? 3); k++) {
    const started = performance.now();
    const report = await classifyDetailed(
      txns,
      { st: "MI", incident_date: "2026-06-14" },
      { payDips: false, deviceExamples: opts.examples },
    );
    const ms = Math.round(performance.now() - started);
    const wrong = report.all
      .map((c, i) => ({ c, r: rows[i] }))
      .filter(({ c, r }) => c.expense !== r.expect)
      .map(({ c, r }) => `${r.merchant} / ${r.description}: ${c.expense} (expected ${r.expect})`);
    runs.push({
      ms,
      correct: rows.length - wrong.length,
      total: rows.length,
      batches: report.device.batches,
      errors: report.device.errors,
      wrong,
    });
  }
  return runs;
}

export interface CaptureRun {
  ms: number;
  status: string;
  sent: number; // rows no rule matched
  answered: number; // of those, rows the model's answer was taken for
  batches: number;
  errors: string[];
  answers: Record<string, string>; // row id -> the label the app took from the model
}

// Runs the held-out set (tests/local/fixtures/classifier-heldout.json) through the on-device model
// in a real browser and keeps the answer for each row no rule matched, keyed by row id, so the
// run can be scored later with no model (scripts/classifier-eval.ts --model). The labels are the
// ones the app took: code turns a model's forensic_exam into medical and its lost_wages into no
// label before anything else sees them. A row the model was not asked about, or gave no usable
// answer for, has no entry and is scored as unsorted, which is what the app would show.
export async function captureDeviceAnswers(
  set: HeldOutSet,
  opts: { runs?: number; examples?: boolean; timeoutMs?: number } = {},
): Promise<CaptureRun[]> {
  const txns = heldOutTxns(set.rows);
  const sent = new Set(
    txns
      .map(toFacts)
      .filter((f) => !classifyDeterministic(f))
      .map((f) => f.ref),
  );
  const runs: CaptureRun[] = [];
  for (let k = 0; k < (opts.runs ?? 1); k++) {
    const started = performance.now();
    const report = await classifyDetailed(txns, set.context, {
      payDips: false,
      deviceExamples: opts.examples,
      deviceTimeoutMs: opts.timeoutMs,
    });
    const ms = Math.round(performance.now() - started);
    const answers: Record<string, string> = {};
    for (const c of report.all) if (sent.has(c.ref) && c.method !== "unresolved") answers[c.ref] = c.expense;
    runs.push({
      ms,
      status: report.device.status,
      sent: sent.size,
      answered: Object.keys(answers).length,
      batches: report.device.batches,
      errors: report.device.errors,
      answers,
    });
  }
  return runs;
}
