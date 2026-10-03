"use client";

import Money from "@/components/Money";
import { useJustChanged } from "@/lib/hooks";
import { useI18n, useSummary } from "@/lib/i18n";
import type { ItemExpense } from "@/lib/types";
import type { LawIndex } from "@/lib/useLaw";
import type { Row } from "../claim";
import Cite from "../Cite";
import StatusMark from "../StatusMark";
import type { YesNoUnsure } from "../state";
import styles from "../flow.module.css";

const COUNTABLE: Row["status"][] = ["eligible", "needs_confirmation", "checking", "declined"];

interface CostRowProps {
  row: Row;
  law: LawIndex;
  onAnswer: (ids: string[], value: YesNoUnsure | null) => void;
  readOnly?: boolean;
}

export default function CostRow({ row, law, onAnswer, readOnly }: CostRowProps) {
  const { t, f } = useI18n();
  const { item, line, status, answer, kind } = row;
  const changed = useJustChanged(status, status !== "checking");
  const subject = `${item.description}, ${f.date(item.date)}`;
  const id = item.item_id;
  const qid = `q-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const capped = line && line.status === "eligible" && line.allowed_cents < line.requested_cents;
  // The classifier writes its reason in English; in Spanish the device translates it when it can.
  const classifierReason = useSummary(item.origin === "bill" ? undefined : item.reason);
  const reason =
    item.origin === "bill"
      ? t.gather.reasonBill(item.line_no ?? 0, item.merchant ?? t.gather.theProvider)
      : classifierReason.text;
  const from = t.gather.from[item.origin];
  const explain = t.statusExplain[status];

  return (
    <li className={`${styles.row} ${changed ? styles.changed : ""}`} data-status={status} id={`row-${qid}`}>
      <p className={styles.rowDate}>
        {item.origin === "bill" ? t.gather.onTheBill : <time dateTime={item.date}>{f.date(item.date, "short")}</time>}
      </p>

      <div className={styles.rowMain}>
        {/* A line the law leaves out gets no "Count this" box: checking it could not make it count. */}
        {!readOnly && kind === "direct" && COUNTABLE.includes(status) ? (
          <label className={styles.include}>
            <input
              type="checkbox"
              checked={answer !== "no"}
              onChange={(e) => onAnswer([id], e.target.checked ? null : "no")}
            />
            <span className={styles.rowDesc}>
              {item.description}
              <span className="visually-hidden">
                , {f.date(item.date)}. {t.gather.include}
              </span>
            </span>
          </label>
        ) : (
          <p className={styles.rowDesc}>{item.description}</p>
        )}
        {/* A bill line's reason already says which bill it is from. */}
        <p className={styles.rowReason}>
          {item.origin !== "bill" ? (
            <span className={styles.rowDateInline}>
              {f.date(item.date, "short")}
              {" · "}
            </span>
          ) : null}
          {reason ? `${reason.trim().replace(/([^.!?])$/, "$1.")} ` : ""}
          {item.origin !== "bill" ? <span className={styles.rowFrom}>{from}</span> : null}
        </p>
        <div className={styles.rowTags}>
          <StatusMark status={status} />
          {line && line.rule_ids.length ? (
            <Cite
              ruleIds={line.rule_ids}
              law={law}
              subject={subject}
              explain={explain}
              tone={status === "held" ? "held" : "default"}
            />
          ) : null}
          {capped ? <span className={styles.rowCap}>{t.gather.capped(f.money(line.requested_cents))}</span> : null}
        </div>

        {status === "unknown_rule" ? <p className={styles.rowNote}>{t.statusExplain.unknown_rule}</p> : null}

        {line?.flags.some((fl) => fl.startsWith("rate_unverified")) ? (
          <p className={styles.rowNote}>{t.gather.rateUnverified}</p>
        ) : null}

        {item.expense === "forensic_exam" && line && line.expense === "medical" ? (
          <p className={styles.rowNote}>{t.gather.examAsMedical}</p>
        ) : null}

        {status === "held" ? <p className={styles.rowHeld}>{t.gather.heldLine}</p> : null}

        {!readOnly && kind === "inferred" && (answer === "yes" || answer === "no") ? (
          <p className={styles.after}>
            {answer === "yes" ? t.gather.saidYes : t.gather.saidNo}{" "}
            <button type="button" className="link-button" onClick={() => onAnswer([id], null)}>
              {t.gather.change}
              <span className="visually-hidden">: {subject}</span>
            </button>
          </p>
        ) : null}
      </div>

      {/* Asked only when a yes would count: a cost the law leaves out gets its rule, not a question. */}
      {!readOnly &&
      kind === "inferred" &&
      (answer === undefined || answer === "unsure") &&
      status === "needs_confirmation" ? (
        <div role="group" aria-labelledby={qid} className={styles.question}>
          <p id={qid} className={styles.qText}>
            {t.question[item.expense as ItemExpense] ?? t.question.other}
            <span className="visually-hidden"> {subject}</span>
          </p>
          <div className={styles.answers}>
            {(
              [
                ["yes", t.common.yes],
                ["no", t.common.no],
                ["unsure", t.common.notSure],
              ] as const
            ).map(([value, label]) => (
              <button key={value} type="button" aria-pressed={answer === value} onClick={() => onAnswer([id], value)}>
                {label}
              </button>
            ))}
          </div>
          {answer === "unsure" ? <p className={styles.after}>{t.gather.unsureNote}</p> : null}
        </div>
      ) : null}

      <p className={styles.rowAmount}>
        {status === "eligible" && line ? (
          <>
            {capped ? <Money cents={line.requested_cents} struck className={styles.was} /> : null}
            <Money cents={line.allowed_cents} className={styles.counted} />
          </>
        ) : status === "held" ? (
          <>
            <Money cents={item.amount_cents} struck className={styles.heldAmount} />
            <span className={styles.amountNote}>{t.gather.dontPay}</span>
          </>
        ) : status === "declined" ? (
          <Money cents={item.amount_cents} struck className={styles.muted} />
        ) : (
          <>
            <Money cents={item.amount_cents} className={styles.muted} />
            <span className={styles.amountNote}>{t.gather.notCounted}</span>
          </>
        )}
      </p>
    </li>
  );
}
