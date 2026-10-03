"use client";

import Link from "next/link";
import { useEffect, useState, type ChangeEvent } from "react";
import type { DeviceAi } from "@/lib/contracts";
import { useI18n } from "@/lib/i18n";
import { useFlow } from "../FlowProvider";
import { sampleBillFile, sampleStatementFile } from "../samples";
import styles from "../flow.module.css";

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
  const { state, services, readStatement, connectBank, readBill } = useFlow();
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [deviceAi, setDeviceAi] = useState<DeviceAi | null>(null);
  const bankUsed = state.sources.some((s) => s.kind === "bank");
  const hasStatement = state.sources.some((s) => s.kind === "statement");

  useEffect(() => {
    let live = true;
    services.classifier
      .deviceAi()
      .then((a) => live && setDeviceAi(a))
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
      {deviceAi ? <p className="meta">{t.gather.deviceAi[deviceAi]}</p> : null}

      <div role="status" className={styles.readStatus}>
        {busy ? <p className="meta">{t.gather.readingLong}</p> : null}
      </div>
      {error ? (
        <p role="alert" className={styles.problem}>
          {error}
        </p>
      ) : null}

      {state.sources.length || state.bills.length ? (
        <ul className={styles.readList} aria-label={t.gather.readListLabel}>
          {state.sources.map((s) => (
            <li key={s.id}>
              {s.kind === "bank" ? t.gather.bankRead(s.read, s.found) : t.gather.statementRead(s.label, s.read, s.found)}
              {s.sample ? <span className={styles.tag}>{t.common.fictional}</span> : null}
              {s.warnings.length ? <span className="meta"> {t.gather.warnings(s.warnings.length)}</span> : null}
            </li>
          ))}
          {state.bills.map((b) => (
            <li key={b.id}>
              {b.reading.status === "ok" && b.reading.total_cents !== null
                ? t.gather.billRead(b.reading.provider ?? b.label, b.reading.lines.length, f.money(b.reading.total_cents))
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
