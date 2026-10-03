"use client";

import Link from "next/link";
import { useState } from "react";
import Money from "@/components/Money";
import { useI18n } from "@/lib/i18n";
import type { ItemExpense } from "@/lib/types";
import { useLaw, type LawIndex } from "@/lib/useLaw";
import { beforeDate, buildRows, groupRows, notCovered, questions, type GroupView } from "../claim";
import EngineNotice from "../EngineNotice";
import { useFlow } from "../FlowProvider";
import type { YesNoUnsure } from "../state";
import styles from "../flow.module.css";
import AddRecords from "./AddRecords";
import CostRow from "./CostRow";

const SHOW = 4;

// One kind of cost. A long group with nothing left to answer folds to its first lines; a group with
// questions always shows every line, so "Yes to all" never confirms something out of sight.
function GroupBed({
  view: g,
  law,
  onAnswer,
}: {
  view: GroupView;
  law: LawIndex;
  onAnswer: (ids: string[], value: YesNoUnsure | null) => void;
}) {
  const { t, f } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const open = g.rows.some((r) => r.status === "needs_confirmation" && r.answer === undefined);
  const folded = !open && !expanded && g.rows.length > SHOW + 1;
  const rows = folded ? g.rows.slice(0, SHOW) : g.rows;
  const listId = `rows-${g.group}`;

  return (
    <section className={styles.bed} aria-labelledby={`g-${g.group}`}>
      <header className={styles.bedHead}>
        <h3 id={`g-${g.group}`}>{t.group[g.group]}</h3>
        <p className={styles.bedTotal}>
          {g.allowedCents > 0
            ? t.gather.counted(f.money(g.allowedCents))
            : g.heldCents > 0
              ? t.gather.heldAmount(f.money(g.heldCents))
              : t.gather.nothingYet}
        </p>
      </header>
      {g.batch ? (
        <div className={styles.batch}>
          <button type="button" className="btn btn-secondary" onClick={() => onAnswer(g.batch!.ids, "yes")}>
            {t.gather.confirmAll((t.nouns[g.batch.expense as ItemExpense] ?? t.nouns.other)(g.batch.ids.length))}
          </button>
          <p className="meta">{t.gather.confirmAllNote}</p>
        </div>
      ) : null}
      <ol className={styles.rows} id={listId}>
        {rows.map((row) => (
          <CostRow key={row.item.item_id} row={row} law={law} onAnswer={onAnswer} />
        ))}
      </ol>
      {g.rows.length > SHOW + 1 && !open ? (
        <button
          type="button"
          className={`link-button ${styles.more}`}
          aria-expanded={!folded}
          aria-controls={listId}
          onClick={() => setExpanded(folded)}
        >
          {folded ? t.gather.showAll(g.rows.length) : t.gather.showFewer}
        </button>
      ) : null}
    </section>
  );
}

function NeedState() {
  const { t } = useI18n();
  return (
    <section className={styles.needState}>
      <h1>{t.gather.title}</h1>
      <p className="lead">{t.gather.needState}</p>
      <div className="btn-row">
        <Link replace href="/check" className="btn btn-primary">
          {t.gather.toCheck}
        </Link>
      </div>
    </section>
  );
}

export default function GatherScreen() {
  const { t } = useI18n();
  const { state, dispatch, claim } = useFlow();
  const law = useLaw(state.check.st || null);
  if (!state.check.st) return <NeedState />;

  const output = claim.evaluation?.output.jurisdiction === state.check.st ? claim.evaluation.output : null;
  const rows = buildRows(state, output);
  const groups = groupRows(rows);
  const open = questions(rows);
  const left = notCovered(rows);
  const early = beforeDate(rows);
  const has = state.items.length > 0 || state.bills.length > 0;
  const answer = (ids: string[], value: YesNoUnsure | null) => dispatch({ type: "answer", ids, value });
  const firstQ = open[0] ? `#row-q-${open[0].item.item_id.replace(/[^a-zA-Z0-9_-]/g, "_")}` : null;

  return (
    <div className={styles.gather}>
      <header className={styles.screenHead}>
        <h1>{t.gather.title}</h1>
        <p className="lead">{t.gather.lead}</p>
      </header>

      {has ? (
        <details className={styles.addMore}>
          <summary>{t.gather.addAnother}</summary>
          <AddRecords />
        </details>
      ) : (
        <AddRecords />
      )}

      {has ? (
        <div className={styles.reviewLayout}>
          <aside className={styles.tally} aria-label={t.gather.tallyLabel}>
            <div aria-live="polite" className={styles.tallyTotal}>
              <p className={styles.tallyLabel}>{t.common.askFor}</p>
              <p className={styles.tallyFigure}>
                {output ? <Money cents={output.totals.allowed_cents} face="inherit" /> : "..."}
              </p>
              <p className={styles.tallyNote}>{t.common.programDecides}</p>
            </div>
            <dl className={styles.tallyFacts}>
              <div>
                <dt>{t.gather.waitingLabel}</dt>
                <dd>
                  {open.length ? t.gather.waiting(open.length) : t.gather.noQuestions}
                  {firstQ ? <a href={firstQ}>{t.gather.firstQuestion}</a> : null}
                </dd>
              </div>
              {output && output.totals.held_cents > 0 ? (
                <div className={styles.heldFact}>
                  <dt>{t.gather.heldLabel}</dt>
                  <dd>
                    <Money cents={output.totals.held_cents} />
                    <Link href="/gather/bills">{t.gather.seeBill}</Link>
                  </dd>
                </div>
              ) : null}
            </dl>
            {state.bills.length ? (
              <Link href="/gather/bills" className="btn btn-primary">
                {t.gather.nextBills(state.bills.length)}
              </Link>
            ) : (
              <Link href="/packet" className="btn btn-primary">
                {t.gather.nextPacket}
              </Link>
            )}
          </aside>

          <section className={styles.found} aria-labelledby="found-title">
            <h2 id="found-title" className={styles.sectionTitle}>
              {t.gather.foundTitle}
            </h2>
            <p className={styles.foundLead}>{t.gather.foundLead}</p>
            <EngineNotice />

            {groups.map((g) => (
              <GroupBed key={g.group} view={g} law={law} onAnswer={answer} />
            ))}

            {left.length ? (
              <section className={styles.bed} aria-labelledby="not-covered">
                <header className={styles.bedHead}>
                  <h3 id="not-covered">{t.gather.notCoveredTitle}</h3>
                </header>
                <p className={styles.foundLead}>{t.gather.notCoveredLead}</p>
                <ol className={styles.rows}>
                  {left.map((row) => (
                    <CostRow key={row.item.item_id} row={row} law={law} onAnswer={answer} />
                  ))}
                </ol>
              </section>
            ) : null}

            {early.length ? <p className={styles.note}>{t.gather.beforeDate(early.length)}</p> : null}
            {state.bills.some((b) => b.replaces) ? <p className={styles.note}>{t.gather.replacedNote}</p> : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}
