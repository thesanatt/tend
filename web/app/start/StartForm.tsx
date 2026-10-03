"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { isIsoDay, todayIso } from "@/lib/dates";
import { DEMO, useSession } from "@/lib/session";
import STATES from "@/lib/states.json";
import type { PoliceReport } from "@/lib/types";
import styles from "./start.module.css";

type Tri = "yes" | "no" | "skip" | "";

const BY_NAME = [...STATES].sort((a, b) => a.name.localeCompare(b.name));

function Choice({
  name,
  legend,
  hint,
  value,
  onChange,
}: {
  name: string;
  legend: string;
  hint: string;
  value: Tri;
  onChange: (v: Tri) => void;
}) {
  const options: [Tri, string][] = [
    ["yes", "Yes"],
    ["no", "No"],
    ["skip", "I'd rather not say"],
  ];
  return (
    <fieldset className={styles.field} aria-describedby={`${name}-hint`}>
      <legend className={styles.label}>{legend}</legend>
      <p id={`${name}-hint`} className={styles.hint}>
        {hint}
      </p>
      <div className={styles.choices}>
        {options.map(([v, label]) => (
          <label key={v} className={styles.choice}>
            <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default function StartForm({ demo }: { demo: boolean }) {
  const router = useRouter();
  const { begin } = useSession();
  const [st, setSt] = useState(demo ? DEMO.st : "");
  const [date, setDate] = useState(demo ? DEMO.incident_date : "");
  const [exam, setExam] = useState<Tri>(demo ? "yes" : "");
  const [police, setPolice] = useState<Tri>(demo ? "no" : "");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const today = todayIso();
  const dateProblem =
    date && !isIsoDay(date) ? "Enter a full date." : date > today ? "The date cannot be in the future." : null;
  const ready = Boolean(st && date && !dateProblem && consent);

  function fillDemo() {
    setSt(DEMO.st);
    setDate(DEMO.incident_date);
    setExam("yes");
    setPolice("no");
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    const police_report: PoliceReport = police === "yes" ? "yes" : police === "no" ? "no" : "unknown";
    try {
      await begin({
        persona_id: DEMO.persona_id,
        st,
        incident_date: date,
        police_report,
        forensic_exam: exam === "yes" ? true : exam === "no" ? false : null,
      });
      router.replace("/ledger");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className={styles.start}>
        <header className={styles.head}>
          <h1>Start a check</h1>
          <p className="lead">
            Tend looks for costs your state&apos;s program covers. It does not ask what happened, and you can skip any
            question you would rather not answer.
          </p>
        </header>

        <aside className={styles.note} aria-label="Content note">
          <p>
            <strong>Content note.</strong> The next screens list medical bills and other costs from after a sexual
            assault, including a forensic exam. You can leave at any time with Exit this page in the corner, or by
            pressing <kbd>Esc</kbd> twice.
          </p>
        </aside>

        <form className={styles.form} onSubmit={submit} noValidate>
          <div className={styles.field}>
            <label htmlFor="st" className={styles.label}>
              Which state did it happen in?
            </label>
            <p id="st-hint" className={styles.hint}>
              The program in that state handles the claim, even if you live somewhere else.
            </p>
            <select id="st" value={st} onChange={(e) => setSt(e.target.value)} aria-describedby="st-hint" required>
              <option value="">Choose a state</option>
              {BY_NAME.map((s) => (
                <option key={s.st} value={s.st}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label htmlFor="date" className={styles.label}>
              On what date did it happen?
            </label>
            <p id="date-hint" className={styles.hint}>
              Tend counts costs from this date on. Filing deadlines count from it too.
            </p>
            <input
              id="date"
              type="date"
              value={date}
              max={today}
              onChange={(e) => setDate(e.target.value)}
              aria-describedby={dateProblem ? "date-hint date-error" : "date-hint"}
              aria-invalid={Boolean(dateProblem)}
              className={styles.date}
              required
            />
            {dateProblem ? (
              <p id="date-error" className={styles.problem}>
                {dateProblem}
              </p>
            ) : null}
          </div>

          <Choice
            name="exam"
            legend="Have you had a medical forensic exam?"
            hint="In many states the exam should cost you nothing, and it can count in place of a police report."
            value={exam}
            onChange={setExam}
          />
          <Choice
            name="police"
            legend="Has it been reported to police?"
            hint="You do not need to have reported it to use Tend. Some programs ask, and Tend shows you their rule."
            value={police}
            onChange={setPolice}
          />

          <div className={styles.field}>
            <p className={styles.label}>Account Tend will read</p>
            <p className={styles.account}>
              Demo checking account for Rowan, a fictional person. The data lives in Nessie, Capital One&apos;s mock
              bank, so no real money is involved.
            </p>
          </div>

          <div className={styles.promise}>
            <h2 className={styles.promiseTitle}>Nothing is filed and no money moves without your yes.</h2>
            <p>
              Each time, you will see the exact amount, the account it comes from, and who receives it, and you will
              type a code to confirm. Tend keeps your answers in this browser tab only. Exit this page clears them.
            </p>
          </div>

          <label className={styles.consent}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>
              Tend may read this account&apos;s transactions from the date above until today. Reading changes nothing.
            </span>
          </label>

          {error ? (
            <p role="alert" className={styles.problem}>
              Tend could not read the account: {error}
            </p>
          ) : null}

          <div className="btn-row">
            <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
              {busy ? "Reading transactions" : "Read transactions"}
            </button>
            {!demo ? (
              <button type="button" className="link-button" onClick={fillDemo}>
                Fill in the demo answers
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </div>
  );
}
