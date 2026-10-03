"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { isIsoDay } from "@/lib/dates";
import { useI18n } from "@/lib/i18n";
import STATES from "@/lib/states.json";
import { useLaw } from "@/lib/useLaw";
import { knowsDate } from "../claim";
import { buildCheckSummary } from "../checkSummary";
import EngineNotice from "../EngineNotice";
import FlowSheet from "../FlowSheet";
import { useFlow } from "../FlowProvider";
import SaveSheet from "../SaveSheet";
import type { PoliceAnswer, YesNoUnsure } from "../state";
import styles from "../flow.module.css";
import CheckSummaryView from "./CheckSummaryView";

const BY_NAME = [...STATES].sort((a, b) => a.name.localeCompare(b.name));

function Choice<T extends string>({
  name,
  legend,
  hint,
  options,
  value,
  onChange,
}: {
  name: string;
  legend: string;
  hint: string;
  options: [T, string][];
  value: T | null;
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className={styles.field} aria-describedby={`${name}-hint`}>
      <legend className={styles.fieldLabel}>{legend}</legend>
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

function NotToday({ open, onClose, deadline }: { open: boolean; onClose: () => void; deadline: string | null }) {
  const { t } = useI18n();
  const { vault, endSession } = useFlow();
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const saved = vault.status === "open";
  return (
    <>
      <FlowSheet
        open={open && !saving}
        onClose={onClose}
        title={t.check.notTodayTitle}
        footer={
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                endSession();
                onClose();
                router.replace("/");
              }}
            >
              {t.check.notTodayClose}
            </button>
            {!saved ? (
              <button type="button" className="btn btn-secondary" onClick={() => setSaving(true)}>
                {t.check.notTodaySave}
              </button>
            ) : null}
          </div>
        }
      >
        <p>{t.check.notTodayBack}</p>
        {deadline ? <p>{deadline}</p> : null}
        <p>{saved ? t.check.notTodaySaved : t.check.notTodayNotSaved}</p>
      </FlowSheet>
      <SaveSheet
        open={saving}
        onClose={() => {
          setSaving(false);
        }}
      />
    </>
  );
}

// Rowan's answers, for the fictional demo (/check?demo=rowan).
export const DEMO_CHECK = { st: "MI", date: "2026-06-14", exam: "yes", police: "not_yet" } as const;

export default function CheckScreen({ demo = false }: { demo?: boolean }) {
  const { t, f } = useI18n();
  const { state, dispatch, claim, today } = useFlow();
  const { check } = state;

  useEffect(() => {
    if (demo && !check.st) dispatch({ type: "check", patch: { ...DEMO_CHECK } });
    // Only on arrival: a demo link fills in empty answers, never ones already given.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo]);
  const law = useLaw(check.st || null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [notToday, setNotToday] = useState(false);
  const [announce, setAnnounce] = useState("");

  const dateProblem =
    check.date && !isIsoDay(check.date) ? t.check.dateBad : check.date > today ? t.check.dateFuture : null;
  const output =
    claim.evaluation && claim.evaluation.output.jurisdiction === check.st ? claim.evaluation.output : null;
  const summary = law.law && check.st ? buildCheckSummary(law.law, output, check, knowsDate(state)) : null;
  const deadlineSentence =
    summary?.deadline.kind === "date" ? t.check.notTodayDeadline(summary.name, f.date(summary.deadline.date)) : null;

  useEffect(() => {
    if (!summary || !output) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAnnounce(t.check.updated(summary.name));
    // The summary text itself is long; one short line tells screen readers it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary?.st, output?.checks.deadline.deadline_date, output?.checks.reporting.status]);

  return (
    <div className={styles.checkLayout}>
      <header className={styles.screenHead}>
        <h1>{t.check.title}</h1>
        <p className="lead">{t.check.lead}</p>
        <p className={styles.note}>{t.check.never}</p>
      </header>

      <form className={styles.form} onSubmit={(e) => e.preventDefault()} noValidate>
        <div className={styles.field}>
          <label htmlFor="st" className={styles.fieldLabel}>
            {t.check.stateLabel}
          </label>
          <p id="st-hint" className={styles.hint}>
            {t.check.stateHint}
          </p>
          <select
            id="st"
            value={check.st}
            onChange={(e) => dispatch({ type: "check", patch: { st: e.target.value } })}
            aria-describedby="st-hint"
          >
            <option value="">{t.check.stateChoose}</option>
            {BY_NAME.map((s) => (
              <option key={s.st} value={s.st}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label htmlFor="date" className={styles.fieldLabel}>
            {t.check.dateLabel}
          </label>
          <p id="date-hint" className={styles.hint}>
            {t.check.dateHint}
          </p>
          <input
            id="date"
            type="date"
            value={check.date}
            max={today}
            disabled={check.dateUnsure}
            onChange={(e) => dispatch({ type: "check", patch: { date: e.target.value } })}
            aria-describedby={dateProblem ? "date-hint date-error" : "date-hint"}
            aria-invalid={Boolean(dateProblem)}
            className={styles.date}
          />
          {dateProblem ? (
            <p id="date-error" className={styles.problem}>
              {dateProblem}
            </p>
          ) : null}
          <label className={styles.checkLine}>
            <input
              type="checkbox"
              checked={check.dateUnsure}
              onChange={(e) =>
                dispatch({ type: "check", patch: e.target.checked ? { dateUnsure: true } : { dateUnsure: false } })
              }
            />
            {t.check.dateUnsure}
          </label>
        </div>

        <Choice<YesNoUnsure>
          name="exam"
          legend={t.check.examLegend}
          hint={t.check.examHint}
          options={[
            ["yes", t.common.yes],
            ["no", t.common.no],
            ["unsure", t.common.notSure],
          ]}
          value={check.exam}
          onChange={(exam) => dispatch({ type: "check", patch: { exam } })}
        />
        <Choice<PoliceAnswer>
          name="police"
          legend={t.check.policeLegend}
          hint={t.check.policeHint}
          options={[
            ["yes", t.common.yes],
            ["not_yet", t.common.notYet],
            ["no", t.common.no],
            ["unsure", t.common.notSure],
          ]}
          value={check.police}
          onChange={(police) => dispatch({ type: "check", patch: { police } })}
        />
      </form>

      <section className={styles.summaryCol} aria-labelledby="summary-title">
        <p className="visually-hidden" role="status">
          {announce}
        </p>
        {!check.st ? (
          <div className={styles.summaryEmpty}>
            <h2 id="summary-title">{t.check.summaryEmptyTitle}</h2>
            <p>{t.check.summaryEmpty}</p>
          </div>
        ) : !summary ? (
          <div className={styles.summaryEmpty}>
            <h2 id="summary-title">{t.check.summaryLoading}</h2>
          </div>
        ) : (
          <>
            <h2 id="summary-title" className={styles.summaryTitle}>
              {t.check.summaryTitle(summary.name)}
            </h2>
            <EngineNotice />
            <CheckSummaryView summary={summary} law={law} ready={Boolean(output)} />
          </>
        )}

        <div className={styles.actions}>
          {check.st ? (
            <Link href="/gather" className="btn btn-primary">
              {t.check.findCosts}
            </Link>
          ) : (
            <button type="button" className="btn btn-primary" disabled aria-describedby="find-hint">
              {t.check.findCosts}
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={() => setSaveOpen(true)}>
            {t.vault.save}
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => setNotToday(true)}>
            {t.check.notToday}
          </button>
          {!check.st ? (
            <p id="find-hint" className={styles.hint}>
              {t.check.findHint}
            </p>
          ) : null}
        </div>
      </section>

      <SaveSheet open={saveOpen} onClose={() => setSaveOpen(false)} />
      <NotToday open={notToday} onClose={() => setNotToday(false)} deadline={deadlineSentence} />
    </div>
  );
}
