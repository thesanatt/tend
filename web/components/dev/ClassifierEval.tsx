"use client";

import { useEffect, useState, type ChangeEvent } from "react";
import type { DeviceAi } from "@/lib/contracts";
import { DEVICE_TIMEOUT_MS } from "@/lib/local/classify";
import { deviceAiStatus, startModelDownload } from "@/lib/local/deviceai";
import { checkSet, HELDOUT_FILES, setHash, type HeldOutSet } from "@/lib/local/heldout";
import { browserToken, captureDeviceAnswers, captureFile, type CaptureFile } from "@/lib/local/measure";
import styles from "./ClassifierEval.module.css";

// Development only (app/dev/classifier-eval). Runs the held-out rows through the model built into
// this browser and saves the answer for each row no rule sorted, so scripts/classifier-eval.ts can
// score the run later with no model. The rows are fictional and nothing is sent anywhere.
const FIXTURES = "tests/local/fixtures";
const SCORE = `npx tsx scripts/classifier-eval.ts --model ${FIXTURES}/${HELDOUT_FILES.nano} --write`;

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

function tally(errors: string[]): string {
  const counts = new Map<string, number>();
  for (const e of errors) counts.set(e, (counts.get(e) ?? 0) + 1);
  return [...counts].map(([e, n]) => (n > 1 ? `${e} (${n} times)` : e)).join("; ");
}

export default function ClassifierEval() {
  const [status, setStatus] = useState<DeviceAi | "checking">("checking");
  const [loaded, setLoaded] = useState(0);
  const [set, setSet] = useState<HeldOutSet | null>(null);
  const [setProblem, setSetProblem] = useState("");
  const [count, setCount] = useState(1);
  const [timeoutMs, setTimeoutMs] = useState(DEVICE_TIMEOUT_MS);
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [file, setFile] = useState<CaptureFile | null>(null);
  const [runProblem, setRunProblem] = useState("");

  useEffect(() => {
    let live = true;
    void deviceAiStatus("text").then((s) => {
      if (live) setStatus(s);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  // Called straight from the click: Chrome only downloads the model with user activation.
  function download() {
    setStatus("downloading");
    void startModelDownload(setLoaded).then(setStatus);
  }

  async function choose(e: ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    setSet(null);
    setFile(null);
    setSetProblem("");
    if (!picked) return;
    try {
      const next = JSON.parse(await picked.text()) as HeldOutSet | null;
      if (!next || !Array.isArray(next.rows) || !next.rows.length || !next.context)
        throw new Error(`this is not ${HELDOUT_FILES.set}: it has no rows`);
      checkSet(next);
      setSet(next);
    } catch (err) {
      setSetProblem(err instanceof Error ? err.message : String(err));
    }
  }

  async function run() {
    if (!set) return;
    setBusy(true);
    setSeconds(0);
    setFile(null);
    setRunProblem("");
    try {
      const runs = await captureDeviceAnswers(set, { runs: count, timeoutMs });
      setFile(
        captureFile(set, runs, {
          made: new Date().toISOString(),
          browser: browserToken(navigator.userAgent),
          timeoutMs,
        }),
      );
    } catch (err) {
      setRunProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      void deviceAiStatus("text").then(setStatus);
    }
  }

  const words: Record<DeviceAi | "checking", string> = {
    checking: "checking",
    available: "ready",
    downloadable: "not downloaded yet",
    downloading: `downloading, ${Math.round(loaded * 100)}%`,
    unavailable: "not available in this browser",
  };
  const answered = file?.runs.some((r) => r.answered > 0) ?? false;
  const href = file
    ? `data:application/json;charset=utf-8,${encodeURIComponent(`${JSON.stringify(file, null, 2)}\n`)}`
    : "";

  return (
    <div className={styles.tool}>
      <h1>Record the built-in model&apos;s answers for the held-out rows</h1>
      <p className={styles.lead}>
        This page is for development and is not part of the built site. It asks the model built into this browser about
        every held-out row no rule sorted, and saves the label the app took for each one. The rows are fictional.
        Nothing is sent anywhere, and the file is scored later with no model.
      </p>

      <section className={styles.step} aria-labelledby="eval-model">
        <h2 id="eval-model">1. The model</h2>
        <p role="status">Built-in model: {words[status]}.</p>
        {status === "downloadable" && (
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" onClick={download}>
              Download the model
            </button>
          </div>
        )}
        {status === "unavailable" && (
          <p className={styles.note}>
            Use desktop Chrome with Gemini Nano. The page chrome://on-device-internals says whether the model is
            installed, and the app only asks the model when Chrome reports it as available.
          </p>
        )}
      </section>

      <section className={styles.step} aria-labelledby="eval-rows">
        <h2 id="eval-rows">2. The rows</h2>
        <div className={styles.fields}>
          <label>
            Choose web/{FIXTURES}/{HELDOUT_FILES.set}
            <input type="file" accept="application/json,.json" onChange={choose} />
          </label>
        </div>
        {set && (
          <p>
            {set.rows.length} rows, set hash {setHash(set)}.
          </p>
        )}
        {setProblem && (
          <p className={styles.problem} role="alert">
            {setProblem}
          </p>
        )}
      </section>

      <section className={styles.step} aria-labelledby="eval-run">
        <h2 id="eval-run">3. Run</h2>
        <div className={styles.fields}>
          <label>
            Runs
            <input
              type="number"
              min={1}
              max={5}
              value={count}
              onChange={(e) => setCount(Math.min(5, Math.max(1, Math.round(Number(e.target.value)) || 1)))}
            />
          </label>
          <label>
            Time limit for a prompt, in ms
            <input
              type="number"
              min={1000}
              step={1000}
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(Math.max(1000, Math.round(Number(e.target.value)) || DEVICE_TIMEOUT_MS))}
            />
          </label>
        </div>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!set || busy || status !== "available"}
            onClick={run}
          >
            Run
          </button>
          <span role="status">{busy ? `Running, ${clock(seconds)} so far. Keep this tab in front.` : ""}</span>
        </div>
        <p className={styles.note}>
          {DEVICE_TIMEOUT_MS} ms is the limit the app uses. A prompt that runs past it gets no answer, and its rows are
          scored as unsorted, which is what the app would show. A longer limit measures the model apart from its speed;
          the file records the limit either way.
        </p>
        {runProblem && (
          <p className={styles.problem} role="alert">
            {runProblem}
          </p>
        )}
      </section>

      {file && (
        <section className={styles.step} aria-labelledby="eval-save">
          <h2 id="eval-save">4. Save</h2>
          <div className={styles.runsWrap}>
            <table className={styles.runs}>
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Rows asked</th>
                  <th scope="col">Answered</th>
                  <th scope="col">Prompts</th>
                  <th scope="col">Time</th>
                  <th scope="col">Prompts that failed</th>
                </tr>
              </thead>
              <tbody>
                {file.runs.map((r, i) => (
                  <tr key={i}>
                    <th scope="row">{i + 1}</th>
                    <td>{r.sent}</td>
                    <td>{r.answered}</td>
                    <td>{r.batches}</td>
                    <td>{clock(Math.round(r.ms / 1000))}</td>
                    <td>{r.errors.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {file.runs.some((r) => r.errors.length > 0) && (
            <p className={styles.note}>Failures: {tally(file.runs.flatMap((r) => r.errors))}.</p>
          )}
          {answered ? (
            <>
              <div className="btn-row">
                <a className="btn btn-primary" href={href} download={HELDOUT_FILES.nano}>
                  Save {HELDOUT_FILES.nano}
                </a>
              </div>
              <p className={styles.note}>
                Move the file into web/{FIXTURES}/, then score it from web/:
                <code className={styles.command}>{SCORE}</code>
              </p>
            </>
          ) : (
            <p className={styles.problem} role="alert">
              The model answered no rows, so there is nothing to save.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
