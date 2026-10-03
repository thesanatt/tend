"use client";

import Link from "next/link";
import FlowGate from "@/components/FlowGate";
import { formatDay, formatTimestamp, todayIso } from "@/lib/dates";
import { BACKEND_LABEL } from "@/lib/engine";
import { expenseLabel } from "@/lib/expenses";
import { formatCents } from "@/lib/money";
import { useSession, type Session } from "@/lib/session";
import { checkCopy, DEADLINE, MINIMUM_LOSS, REPORTING } from "@/lib/status";
import type { Rule } from "@/lib/types";
import { useLaw } from "@/lib/useLaw";
import styles from "./packet.module.css";

function PacketView({ session }: { session: Session }) {
  const { claim } = useSession();
  const law = useLaw(session.st);
  const evaluation = claim.evaluation;
  const output = evaluation?.output;
  if (!output || !law.law) return <p className="meta">Preparing the packet</p>;

  const items = new Map(session.scan.items.map((i) => [i.item_id, i]));
  const eligible = output.lines.filter((l) => l.status === "eligible" && l.allowed_cents > 0);
  const held = output.lines.filter((l) => l.status === "held");
  const { checks } = output;
  const cited = new Set<string>([
    ...eligible.flatMap((l) => [...l.rule_ids, ...(l.cap_rule_id ? [l.cap_rule_id] : [])]),
    ...held.flatMap((l) => l.rule_ids),
    ...checks.deadline.rule_ids,
    ...checks.reporting.rule_ids,
    ...checks.minimum_loss.rule_ids,
  ]);
  const rules = law.law.rules.filter((r) => cited.has(r.id));
  const program = law.law.program;
  const first = (ids: string[]) => ids.map((id) => law.rule(id)).find((r): r is Rule => Boolean(r));

  return (
    <div className={styles.wrap}>
      <div className={`${styles.toolbar} no-print`}>
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>
          Print or save as PDF
        </button>
        <Link replace href="/claim">
          Back to the claim
        </Link>
        <p className="meta">Your browser&apos;s print window can save this as a PDF. Nothing is uploaded.</p>
      </div>

      <article className={styles.sheet}>
        <header className={styles.head}>
          <p className={styles.kicker}>Supporting costs for a crime victim compensation claim</p>
          <h1>
            {program.program_name}, {law.law.name}
          </h1>
          <p>{program.agency}</p>
          <dl className={styles.facts}>
            <div>
              <dt>Prepared</dt>
              <dd>{formatDay(todayIso())}</dd>
            </div>
            <div>
              <dt>Costs from</dt>
              <dd>{formatDay(session.incident_date)}</dd>
            </div>
            {program.statute_citation ? (
              <div>
                <dt>Statute</dt>
                <dd>{program.statute_citation}</dd>
              </div>
            ) : null}
          </dl>
          <div className={styles.fill}>
            <p>Name: ______________________________</p>
            <p>Claim number, if any: ________________</p>
          </div>
        </header>

        <section className={styles.section}>
          <h2>Summary</h2>
          <dl className={styles.summary}>
            <div>
              <dt>Amount requested</dt>
              <dd>
                <strong>{formatCents(output.totals.allowed_cents)}</strong> for {eligible.length} costs. The program
                decides the award.
              </dd>
            </div>
            {held.length ? (
              <div>
                <dt>Bill held by law</dt>
                <dd>
                  {formatCents(output.totals.held_cents)} for a forensic exam, which{" "}
                  {first(held[0].rule_ids)?.pinpoint ?? "the law"} says should not be billed to the survivor.
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Filing deadline</dt>
              <dd>
                {checkCopy(DEADLINE, checks.deadline.status).label}
                {checks.deadline.deadline_date ? `: file by ${formatDay(checks.deadline.deadline_date)}` : ""} (
                {checks.deadline.rule_ids.join(", ") || "no rule"})
              </dd>
            </div>
            <div>
              <dt>Reporting</dt>
              <dd>
                {checkCopy(REPORTING, checks.reporting.status).label} (
                {checks.reporting.rule_ids.join(", ") || "no rule"})
              </dd>
            </div>
            <div>
              <dt>Minimum loss</dt>
              <dd>
                {checkCopy(MINIMUM_LOSS, checks.minimum_loss.status).label} (
                {checks.minimum_loss.rule_ids.join(", ") || "no rule"})
              </dd>
            </div>
          </dl>
        </section>

        <section className={styles.section}>
          <h2>Costs</h2>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Cost</th>
                <th scope="col">Rules</th>
                <th scope="col" className={styles.num}>
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {eligible.map((l) => {
                const item = items.get(l.item_id);
                return (
                  <tr key={l.item_id}>
                    <td className={styles.nowrap}>{item ? formatDay(item.date, "numeric") : ""}</td>
                    <td>
                      {item?.description}
                      <span className={styles.sub}>
                        {expenseLabel(l.expense)}. Record {l.item_id}
                        {session.life[l.item_id]?.receipt ? `. Receipt: ${session.life[l.item_id]!.receipt}` : ""}
                      </span>
                    </td>
                    <td className={styles.rules}>
                      {[...l.rule_ids, ...(l.cap_rule_id ? [l.cap_rule_id] : [])].join(" ")}
                    </td>
                    <td className={styles.num}>
                      {formatCents(l.allowed_cents)}
                      {l.allowed_cents < l.requested_cents ? (
                        <span className={styles.sub}>of {formatCents(l.requested_cents)}</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={3}>
                  Total requested
                </th>
                <td className={styles.num}>{formatCents(output.totals.allowed_cents)}</td>
              </tr>
            </tfoot>
          </table>
        </section>

        <section className={styles.section}>
          <h2>The law cited</h2>
          <p className={styles.note}>
            Each quote is copied word for word from the official source listed with it. The fingerprint (SHA-256)
            identifies the exact saved copy Tend checked.
          </p>
          <ol className={styles.law}>
            {rules.map((r) => {
              const src = law.source(r.source_id);
              return (
                <li key={r.id}>
                  <p className={styles.lawHead}>
                    <strong>{r.pinpoint}</strong> <span className={styles.sub}>{r.id}</span>
                  </p>
                  <blockquote>{r.quote}</blockquote>
                  {src ? (
                    <p className={styles.sub}>
                      {src.title}. {src.url}. Saved {formatTimestamp(src.retrieved_at)}. SHA-256 {src.sha256}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>

        <footer className={styles.foot}>
          <p>
            Prepared with Tend from verified rules. Math by: {evaluation ? BACKEND_LABEL[evaluation.backend] : ""}. Law
            image SHA-256 {output.law_image_sha256}.
          </p>
          <p>Tend is not legal advice. The program decides every claim. Demo data in this packet is fictional.</p>
        </footer>
      </article>
    </div>
  );
}

export default function PacketScreen() {
  return <FlowGate>{(session) => <PacketView session={session} />}</FlowGate>;
}
