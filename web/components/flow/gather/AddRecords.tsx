"use client";

import Link from "next/link";
import { useEffect, useState, type ChangeEvent } from "react";
import type { DeviceAi } from "@/lib/contracts";
import { useI18n } from "@/lib/i18n";
import { offline } from "@/lib/netlog";
import { offered } from "../claim";
import CloudConsent, { type CloudAsk } from "../CloudConsent";
import { useFlow } from "../FlowProvider";
import { sampleBillFile, sampleStatementFile } from "../samples";
import { recordOf, type FlowState } from "../state";
import styles from "../flow.module.css";

// How many rows a reader left out. Its other notes ("Read negative amounts as money spent.") are
// not skipped rows; "3 cancelled records were left out." counts 3.
export function skippedRows(warnings: string[]): number {
  let n = 0;
  for (const w of warnings) {
    if (/^(Line|Record|Page \d+, line) \d+ skipped\b/.test(w)) n += 1;
    else {
      const m = /^(\d+) cancelled records? (?:was|were) left out/.exec(w);
      if (m) n += Number(m[1]);
    }
  }
  return n;
}

// Rows of one record that nothing on this device could sort, and that could still count: these are
// what cloud AI would be asked about, after a yes.
export function unsortedRows(state: FlowState, sourceId: string, today: string): number {
  return state.items.filter(
    (it) => it.origin !== "bill" && recordOf(it) === sourceId && it.expense === "unknown" && offered(state, it, today),
  ).length;
}

// On-device AI: say whether it is here, and let the survivor add it with one tap (the download
// needs that tap). Nothing about the survivor is sent to get the model.
function DeviceAiLine({ status, onChange }: { status: DeviceAi | null; onChange: (s: DeviceAi) => void }) {
  const { t } = useI18n();
  const { services } = useFlow();
  const [progress, setProgress] = useState<number | null>(null);
  if (!status) return null;

  function add() {
    if (!services.startDeviceAi) return;
    // Straight from the tap, before anything is awaited: Chrome downloads only with user activation.
    const pending = services.startDeviceAi((loaded) => setProgress(loaded));
    setProgress(0);
    onChange("downloading");
    pending
      .then((s) => onChange(s))
      .catch(() => onChange("unavailable"))
      .finally(() => setProgress(null));
  }

  return (
    <div className={styles.aiOffer}>
      <p className="meta" role="status">
        {status === "downloading" && progress !== null
          ? t.gather.deviceAiProgress(Math.round(progress * 100))
          : t.gather.deviceAi[status]}
      </p>
      {status === "downloadable" && services.startDeviceAi ? (
        <>
          <button type="button" className="btn btn-quiet" onClick={add}>
            {t.gather.deviceAiAdd}
          </button>
          <p className="meta">{t.gather.deviceAiAddNote}</p>
        </>
      ) : null}
    </div>
  );
}

type Busy = "statement" | "bank" | "bill" | null;

function FilePick({
  id,
  label,
  accept,
  primary,
  disabled,
  onFile,
}: {
  id: string;
  label: string;
  accept: string;
  primary?: boolean;
  disabled?: boolean;
  onFile: (file: File) => void;
}) {
  return (
    <label
      htmlFor={id}
      className={`btn ${primary ? "btn-primary" : "btn-secondary"} ${styles.filePick}`}
      aria-disabled={disabled || undefined}
    >
      <input
        id={id}
        type="file"
        accept={accept}
        className="visually-hidden"
        disabled={disabled}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onFile(file);
        }}
      />
      {label}
    </label>
  );
}

export default function AddRecords() {
  const { t, f } = useI18n();
  const { state, services, today, readStatement, connectBank, readBill, canReread, cloudSort, refining } = useFlow();
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [deviceAi, setDeviceAi] = useState<DeviceAi | null>(null);
  // Cloud AI: which record the consent screen is about, and what happened after a yes.
  const [ask, setAsk] = useState<{ source: string; ask: CloudAsk } | null>(null);
  const [cloudNote, setCloudNote] = useState<string | null>(null);
  const bankUsed = state.sources.some((s) => s.kind === "bank");
  const hasStatement = state.sources.some((s) => s.kind === "statement");

  async function sortWithCloud(source: string) {
    setAsk(null);
    setCloudNote(null);
    setBusy("statement");
    try {
      const sorted = await cloudSort(source);
      // Offline, the rows never left; cloud AI is simply not reachable.
      setCloudNote(sorted ? t.cloud.sorted(sorted) : offline() ? t.cloud.offline : t.cloud.noneSorted);
    } catch {
      setCloudNote(offline() ? t.cloud.offline : t.cloud.failed);
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    let live = true;
    services.classifier
      .deviceAi()
      .then((a) => {
        if (!live) return;
        setDeviceAi(a);
        // Starting the on-device model takes seconds, so it starts while the survivor picks a file.
        // It never downloads anything (lib/local/classify.ts prewarm).
        if (a === "available")
          (services.classifier as { prewarm?: () => Promise<unknown> }).prewarm?.().catch(() => {});
      })
      .catch(() => live && setDeviceAi("unavailable"));
    return () => {
      live = false;
    };
  }, [services]);

  async function run(kind: Exclude<Busy, null>, work: () => Promise<unknown>) {
    setBusy(kind);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(t.gather.readFailed((err as Error).message));
    } finally {
      setBusy(null);
    }
  }

  const statement = (file: File, sample = false) =>
    run("statement", async () => {
      const source = await readStatement(file, sample);
      if (!source.read) setError(t.gather.unsupported);
    });
  const bill = (file: File, sample = false) => run("bill", () => readBill(file, sample));

  return (
    <section className={styles.add} aria-labelledby="add-title" aria-busy={busy !== null}>
      <h2 id="add-title" className={styles.sectionTitle}>
        {t.gather.addTitle}
      </h2>

      <ol className={styles.options}>
        <li className={styles.option}>
          <div>
            <h3>{t.gather.statementTitle}</h3>
            <p>{t.gather.statementBody}</p>
          </div>
          <div className={styles.optionActions}>
            <FilePick
              id="statement-file"
              label={busy === "statement" ? t.gather.reading : t.gather.statementButton}
              accept=".csv,.ofx,.qfx,.pdf,text/csv,application/pdf,application/x-ofx"
              primary={!state.items.length}
              disabled={busy !== null}
              onFile={(file) => statement(file)}
            />
            <button
              type="button"
              className="link-button"
              disabled={busy !== null || hasStatement}
              onClick={() => statement(sampleStatementFile(), true)}
            >
              {t.gather.statementSample}
            </button>
          </div>
        </li>

        <li className={styles.option}>
          <div>
            <h3>{t.gather.bankTitle}</h3>
            <p>{t.gather.bankBody}</p>
          </div>
          <div className={styles.optionActions}>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy !== null || bankUsed}
              onClick={() => run("bank", connectBank)}
            >
              {busy === "bank" ? t.gather.reading : bankUsed ? t.gather.bankDone : t.gather.bankButton}
            </button>
          </div>
        </li>

        <li className={styles.option}>
          <div>
            <h3>{t.gather.billTitle}</h3>
            <p>{t.gather.billBody}</p>
          </div>
          <div className={styles.optionActions}>
            <FilePick
              id="bill-file"
              label={busy === "bill" ? t.gather.reading : t.gather.billButton}
              accept="image/*,application/pdf"
              disabled={busy !== null}
              onFile={(file) => bill(file)}
            />
            <button
              type="button"
              className="link-button"
              disabled={busy !== null || state.bills.some((b) => b.sample)}
              onClick={() => bill(sampleBillFile(), true)}
            >
              {t.gather.billSample}
            </button>
          </div>
        </li>
      </ol>

      <p className={styles.note}>{t.gather.samplesNote}</p>
      <DeviceAiLine status={deviceAi} onChange={setDeviceAi} />

      <div role="status" className={styles.readStatus}>
        {busy ? <p className="meta">{t.gather.readingLong}</p> : null}
        {cloudNote ? <p className="meta">{cloudNote}</p> : null}
      </div>
      <CloudConsent ask={ask?.ask ?? null} onNo={() => setAsk(null)} onYes={() => ask && sortWithCloud(ask.source)} />
      {error ? (
        <p role="alert" className={styles.problem}>
          {error}
        </p>
      ) : null}

      {state.sources.length || state.bills.length ? (
        <ul className={styles.readList} aria-label={t.gather.readListLabel}>
          {state.sources.map((s) => {
            // Without on-device AI, rows the rules could not sort may go to cloud AI, per file, after a yes.
            const unsorted =
              deviceAi && deviceAi !== "available" && canReread(s.id) ? unsortedRows(state, s.id, today) : 0;
            return (
              <li key={s.id}>
                {s.kind === "bank"
                  ? t.gather.bankRead(s.read, s.found)
                  : t.gather.statementRead(s.label, s.read, s.found)}
                {s.sample ? <span className={styles.tag}>{t.common.fictional}</span> : null}
                {skippedRows(s.warnings) ? (
                  <span className="meta"> {t.gather.warnings(skippedRows(s.warnings))}</span>
                ) : null}
                {s.already ? <span className={`meta ${styles.already}`}>{t.gather.already(s.already)}</span> : null}
                {refining.includes(s.id) ? (
                  <span className={`meta ${styles.already}`} role="status">
                    {t.gather.deviceAiSorting}
                  </span>
                ) : null}
                {unsorted ? (
                  <span className={styles.aiOffer}>
                    <span className="meta">{t.cloud.offer(unsorted)}</span>
                    <button
                      type="button"
                      className="link-button"
                      disabled={busy !== null}
                      onClick={() => setAsk({ source: s.id, ask: { kind: "rows", rows: unsorted } })}
                    >
                      {t.cloud.offerButton}
                    </button>
                  </span>
                ) : null}
              </li>
            );
          })}
          {state.bills.map((b) => (
            <li key={b.id}>
              {b.reading.status === "ok" && b.reading.total_cents !== null
                ? t.gather.billRead(
                    b.reading.provider ?? b.label,
                    b.reading.lines.length,
                    f.money(b.reading.total_cents),
                  )
                : t.gather.billUnreliable(b.label)}
              {b.sample ? <span className={styles.tag}>{t.common.fictional}</span> : null}{" "}
              <Link href="/gather/bills">{t.gather.seeBill}</Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
