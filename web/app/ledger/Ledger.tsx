"use client";

import Link from "next/link";
import FlowGate from "@/components/FlowGate";
import Money from "@/components/Money";
import Bed from "@/components/ledger/Bed";
import { formatDay } from "@/lib/dates";
import { BACKEND_LABEL } from "@/lib/engine";
import { buildRows, earlierRows, groupBeds, notCounted, openQuestions, type Row } from "@/lib/ledger";
import { useSession, type Session } from "@/lib/session";
import STATES from "@/lib/states.json";
import { useLaw } from "@/lib/useLaw";
import styles from "./ledger.module.css";

const stateName = (st: string) => STATES.find((s) => s.st === st)?.name ?? st;

function notCountedText(rows: Row[]): string {
  const excluded = rows.filter((r) => r.status === "excluded").length;
  const unnamed = rows.length - excluded;
  const parts = [];
  if (excluded) parts.push(`${excluded} excluded by the law`);
  if (unnamed) parts.push(`${unnamed} not named in the verified rules`);
  return parts.join("; ");
}

function LedgerView({ session }: { session: Session }) {
  const { claim, answer } = useSession();
  const law = useLaw(session.st);
  const output = claim.evaluation?.output ?? null;
  const rows = buildRows(session.scan.items, session.answers, output);
  const beds = groupBeds(rows, output);
  const questions = openQuestions(rows);
  const earlier = earlierRows(rows);
  const left = notCounted(rows);
  const account = session.scan.account;

  return (
    <div className={styles.layout}>
      <header className={styles.head}>
        <h1>What Tend found</h1>
        <p className={styles.meta}>
          {stateName(session.st)} law. Costs from {formatDay(session.incident_date)} to{" "}
          {formatDay(session.scan.as_of_date)}. {session.scan.read_count ?? session.scan.items.length} transactions read
          {account ? ` from ${account.nickname} ending ${account.mask}` : ""}. Demo data.
        </p>
        <p>Some lines are Tend&apos;s guesses from the bank history. A guess counts only after you say yes.</p>
      </header>

      <div className={styles.beds}>
        {claim.status === "error" ? (
          <p role="alert" className={styles.problem}>
            Tend could not check these costs against the law: {claim.error}
          </p>
        ) : null}
        {beds.map((bed) => (
          <Bed key={bed.expense} bed={bed} law={law} onAnswer={answer} />
        ))}
        {earlier.length ? (
          <p className={styles.footnote}>
            {earlier.length === 1 ? "1 transaction" : `${earlier.length} transactions`} from before{" "}
            {formatDay(session.incident_date)} {earlier.length === 1 ? "was" : "were"} left out.
          </p>
        ) : null}
      </div>

      <aside className={styles.summary} aria-label="Summary">
        <div className={styles.total} aria-live="polite">
          <p className={styles.totalLabel}>Amount you can ask for</p>
          <p className={styles.totalFigure}>
            {output ? <Money cents={output.totals.allowed_cents} face="inherit" /> : "..."}
          </p>
          <p className={styles.totalNote}>The program decides.</p>
        </div>
        <dl className={styles.facts}>
          {output && output.totals.held_cents > 0 ? (
            <div className={styles.heldFact}>
              <dt>Held, do not pay</dt>
              <dd>
                <Money cents={output.totals.held_cents} />
                <Link replace href="/bill">
                  See the bill and the law
                </Link>
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Waiting on you</dt>
            <dd>
              {questions.length === 0 ? (
                "No questions left"
              ) : (
                <>
                  {questions.length === 1 ? "1 question" : `${questions.length} questions`}
                  <a href={`#row-${questions[0].item.item_id}`}>Go to the first one</a>
                </>
              )}
            </dd>
          </div>
          {left.length ? (
            <div>
              <dt>Not counted</dt>
              <dd>{notCountedText(left)}</dd>
            </div>
          ) : null}
        </dl>
        <Link replace href="/claim" className="btn btn-primary">
          Review the claim
        </Link>
        {claim.evaluation ? (
          <p className="meta">
            {claim.status === "computing" ? "Updating. " : ""}Math by: {BACKEND_LABEL[claim.evaluation.backend]}.
          </p>
        ) : null}
      </aside>
    </div>
  );
}

export default function Ledger() {
  return <FlowGate>{(session) => <LedgerView session={session} />}</FlowGate>;
}
