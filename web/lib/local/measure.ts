// Measures the on-device classifier in a real browser: accuracy against labeled rows and time
// per run. Used with tests/local/fixtures/device-eval*.json from a dev page or the console; the
// rows are fictional and nothing leaves the device.
import { classifyDetailed } from "./classify";
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
