"use client";

import Citation from "@/components/Citation";
import Money from "@/components/Money";
import StatusTag from "@/components/StatusTag";
import { formatDay } from "@/lib/dates";
import { expenseQuestion, unitLabel } from "@/lib/expenses";
import { useJustChanged } from "@/lib/hooks";
import type { Row } from "@/lib/ledger";
import { formatCents } from "@/lib/money";
import type { Answer } from "@/lib/session";
import { parseFlag } from "@/lib/status";
import type { LawIndex } from "@/lib/useLaw";
import styles from "./ledger.module.css";

interface LedgerRowProps {
  row: Row;
  law: LawIndex;
  onAnswer: (itemId: string, value: Answer | null) => void;
  readOnly?: boolean;
}

function capText(law: LawIndex, ruleId: string): string {
  const rule = law.rule(ruleId);
  const amount = rule?.params?.amount_cents;
  const per = rule?.params?.per;
  if (typeof amount !== "number") return "A limit in the law applies to this cost.";
  return `The law limits this kind of cost to ${formatCents(amount)}${per && per !== "claim" ? ` per ${per}` : " in total"}.`;
}

const PER_UNIT = new Set(["week", "session", "hour", "mile", "day"]);

// A per-unit limit the engine could not apply because the bank data has no unit count.
function rateText(law: LawIndex, ruleId: string): string {
  const rule = law.rule(ruleId);
  const amount = rule?.params?.amount_cents;
  const per = String(rule?.params?.per ?? "unit").replace(/_/g, " ");
  const limit = typeof amount === "number" ? `${formatCents(amount)} per ${per}` : `a set amount per ${per}`;
  return PER_UNIT.has(per)
    ? `The law limits this to ${limit}. Tend needs the number of ${per}s to apply it, so the program may adjust it.`
    : `The law limits this to ${limit}. Tend did not apply that limit, so the program may adjust it.`;
}

export default function LedgerRow({ row, law, onAnswer, readOnly }: LedgerRowProps) {
  const { item, line, status, answer } = row;
  const changed = useJustChanged(status, status !== "checking");
  const subject = `${item.description}, ${formatDay(item.date)}`;
  const units = unitLabel(item.expense, item.units);
  const capped = line && line.status === "eligible" && line.allowed_cents < line.requested_cents;
  const rateFlags = (line?.flags ?? []).map(parseFlag).filter((f) => f.kind === "rate_unverified" && f.ruleId);

  return (
    <li className={`${styles.row} ${changed ? styles.changed : ""}`} data-status={status} id={`row-${item.item_id}`}>
      <p className={styles.date}>
        <time dateTime={item.date}>{formatDay(item.date, "short")}</time>
      </p>

      <div className={styles.main}>
        <p className={styles.desc}>
          {item.description}
          {units ? <span className={styles.units}> {units}</span> : null}
        </p>

        <div className={styles.tags}>
          {status === "checking" ? (
            <span className="meta">Checking the law</span>
          ) : status === "declined" ? (
            <StatusTag status="declined" label="You said not related" />
          ) : (
            <StatusTag status={status} />
          )}
          {line && status !== "declined" ? (
            <Citation ruleIds={line.rule_ids} status={status} law={law} subject={subject} />
          ) : null}
        </div>

        {capped && line?.cap_rule_id ? (
          <p className={styles.note}>
            Limited from {formatCents(line.requested_cents)}.{" "}
            <Citation
              ruleIds={[line.cap_rule_id]}
              status="eligible"
              law={law}
              subject={subject}
              title="Why this is limited"
              explain={capText(law, line.cap_rule_id)}
            />
          </p>
        ) : null}

        {rateFlags.map(({ ruleId }) => (
          <p key={ruleId} className={styles.note}>
            {rateText(law, ruleId!)}{" "}
            <Citation
              ruleIds={[ruleId!]}
              status="eligible"
              law={law}
              subject={subject}
              title="A limit that may apply"
              explain={capText(law, ruleId!)}
            />
          </p>
        ))}

        {line?.flags.includes("exam_as_medical") ? (
          <p className={styles.note}>This state has no separate exam rule, so Tend counts it as medical care.</p>
        ) : null}

        {!readOnly && status === "needs_confirmation" ? (
          <>
            <div role="group" aria-labelledby={`q-${item.item_id}`} className={styles.question}>
              <p id={`q-${item.item_id}`} className={styles.qText}>
                {expenseQuestion(item.expense)}
              </p>
              <div className={styles.answers}>
                {(
                  [
                    ["yes", "Yes"],
                    ["no", "No"],
                    ["unsure", "Not sure"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={answer === value}
                    onClick={() => onAnswer(item.item_id, value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {answer === "unsure" ? (
              <p className={styles.after}>That is fine. It stays out of the total until you decide.</p>
            ) : null}
          </>
        ) : null}

        {!readOnly && (answer === "yes" || answer === "no") ? (
          <p className={styles.after}>
            You said {answer}.{" "}
            <button type="button" className="link-button" onClick={() => onAnswer(item.item_id, null)}>
              Change answer
              <span className="visually-hidden"> for {subject}</span>
            </button>
          </p>
        ) : null}
      </div>

      <p className={styles.amount}>
        {status === "eligible" && line ? (
          <>
            {capped ? <Money cents={line.requested_cents} struck className={styles.was} /> : null}
            <Money cents={line.allowed_cents} className={styles.counted} />
          </>
        ) : status === "held" ? (
          <>
            <Money cents={item.amount_cents} struck className={styles.heldAmount} />
            <span className={styles.amountNote}>Do not pay</span>
          </>
        ) : status === "declined" ? (
          <Money cents={item.amount_cents} struck className={styles.muted} />
        ) : (
          <>
            <Money cents={item.amount_cents} className={styles.muted} />
            <span className={styles.amountNote}>Not counted</span>
          </>
        )}
      </p>
    </li>
  );
}
