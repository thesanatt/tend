"use client";

import { useEffect, useState } from "react";
import ContactSheet from "@/components/bill/ContactSheet";
import PaySheet from "@/components/bill/PaySheet";
import Citation from "@/components/Citation";
import ContentNote from "@/components/ContentNote";
import FlowGate from "@/components/FlowGate";
import Money from "@/components/Money";
import RuleCard from "@/components/RuleCard";
import StatusTag from "@/components/StatusTag";
import { auditBill } from "@/lib/api";
import { formatDay, formatTimestamp } from "@/lib/dates";
import { formatCents, sumCents } from "@/lib/money";
import { useSession, type Session } from "@/lib/session";
import type { BillAudit } from "@/lib/types";
import { useLaw } from "@/lib/useLaw";
import styles from "@/components/bill/bill.module.css";

function BillView({ session }: { session: Session }) {
  const { claim, addPayment } = useSession();
  const law = useLaw(session.st);
  const billId = session.scan.items.find((i) => i.bill_id)?.bill_id ?? null;
  const [bill, setBill] = useState<BillAudit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"contact" | "pay" | null>(null);

  useEffect(() => {
    if (!billId) return;
    let live = true;
    auditBill(billId, session.persona_id)
      .then((b) => live && setBill(b))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [billId, session.persona_id]);

  if (!billId) return <p className={styles.empty}>Tend did not find a bill in this account.</p>;
  if (error)
    return (
      <p role="alert" className={styles.problem}>
        Tend could not read the bill: {error}
      </p>
    );
  if (!bill) return <p className="meta">Reading the bill</p>;

  const output = claim.evaluation?.output ?? null;
  const statusOf = (itemId: string) => output?.lines.find((l) => l.item_id === itemId)?.status ?? null;
  const lineFor = (itemId: string) => output?.lines.find((l) => l.item_id === itemId) ?? null;
  const heldLines = bill.lines.filter((l) => statusOf(l.item_id) === "held");
  const payLines = bill.lines.filter((l) => statusOf(l.item_id) !== "held");
  const heldCents = sumCents(heldLines.map((l) => l.amount_cents));
  const restCents = sumCents(payLines.map((l) => l.amount_cents));
  const adds =
    bill.lines_sum_cents === bill.total_cents && sumCents(bill.lines.map((l) => l.amount_cents)) === bill.total_cents;
  const forBill = session.payments.filter((p) => p.item_ids.some((id) => bill.lines.some((l) => l.item_id === id)));
  const payment = forBill.at(-1);
  const paid = forBill.some((p) => p.status === "done");
  const noBill = law.byCategory("exam_no_bill");
  const examPay = law.byCategory("exam_payment");
  const heldRuleIds = heldLines.length ? (lineFor(heldLines[0].item_id)?.rule_ids ?? []) : [];
  const account = session.scan.account ?? { id: "demo", nickname: "Checking", mask: "0000" };

  return (
    <div className={styles.screen}>
      <div className={styles.layout}>
        <section className={styles.bill} aria-labelledby="bill-title">
          <header className={styles.billHead}>
            <p className={styles.provider}>{bill.provider}</p>
            <h1 id="bill-title" className={styles.billTitle}>
              Itemized bill
            </h1>
            <dl className={styles.billMeta}>
              {bill.account_ref ? (
                <div>
                  <dt>Account</dt>
                  <dd>{bill.account_ref}</dd>
                </div>
              ) : null}
              <div>
                <dt>Service date</dt>
                <dd>{formatDay(bill.service_date)}</dd>
              </div>
              <div>
                <dt>Statement date</dt>
                <dd>{formatDay(bill.statement_date)}</dd>
              </div>
            </dl>
          </header>

          <table className={styles.table}>
            <caption className="visually-hidden">Bill lines and what the law says about each</caption>
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col">Service</th>
                <th scope="col" className={styles.num}>
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {bill.lines.map((l) => {
                const status = statusOf(l.item_id);
                const held = status === "held";
                return (
                  <tr key={l.item_id} className={held ? styles.heldRow : undefined}>
                    <td className={styles.lineNo}>{l.line_no}</td>
                    <td>
                      <span className={styles.service}>{l.description}</span>
                      {status ? (
                        <span className={styles.lineStatus}>
                          <StatusTag status={status} />
                          {held ? (
                            <span className={styles.heldWhy}>The law says you should not be billed for this.</span>
                          ) : null}
                        </span>
                      ) : null}
                    </td>
                    <td className={styles.num}>
                      {held ? (
                        <Money cents={l.amount_cents} struck className={styles.heldAmount} />
                      ) : (
                        <Money cents={l.amount_cents} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={2}>
                  Bill total
                </th>
                <td className={styles.num}>
                  <Money cents={bill.total_cents} />
                </td>
              </tr>
              {heldCents > 0 ? (
                <tr className={styles.heldTotal}>
                  <th scope="row" colSpan={2}>
                    Held by law, do not pay
                  </th>
                  <td className={styles.num}>
                    <Money cents={-heldCents} />
                  </td>
                </tr>
              ) : null}
              <tr className={styles.rest}>
                <th scope="row" colSpan={2}>
                  The rest
                </th>
                <td className={styles.num}>
                  <Money cents={restCents} />
                </td>
              </tr>
            </tfoot>
          </table>
          <p className="meta">
            {adds
              ? `The ${bill.lines.length} lines add up to the bill total.`
              : "The lines do not add up to the bill total. Ask the provider for a corrected bill before paying."}
          </p>
        </section>

        <aside className={styles.law} aria-labelledby="law-title">
          {heldLines.length ? (
            <>
              <h2 id="law-title" className={styles.lawTitle}>
                {law.law?.name ?? "The"} law says you should not get this bill
              </h2>
              {noBill[0] ? <RuleCard rule={noBill[0]} source={law.source(noBill[0].source_id)} /> : null}
              {examPay[0] ? (
                <div className={styles.lawMore}>
                  <h3>Who pays instead</h3>
                  <RuleCard rule={examPay[0]} source={law.source(examPay[0].source_id)} />
                </div>
              ) : null}
              {heldRuleIds.length > 2 ? (
                <p className={styles.allRules}>
                  All {heldRuleIds.length} rules behind this hold:{" "}
                  <Citation
                    ruleIds={heldRuleIds}
                    status="held"
                    law={law}
                    subject={`${heldLines[0].description}, ${formatDay(bill.service_date)}`}
                  />
                </p>
              ) : null}
            </>
          ) : (
            <>
              <h2 id="law-title" className={styles.lawTitle}>
                No line on this bill is held
              </h2>
              <p>
                {law.law?.name ?? "This state"}&apos;s verified rules do not include an exam billing rule, so Tend
                treats every line as a cost you can claim.
              </p>
            </>
          )}
        </aside>
      </div>

      <section className={styles.actions} aria-labelledby="actions-title">
        <h2 id="actions-title">What you can do</h2>
        {payment ? (
          <div className={styles.receipt} role="status">
            <p className={styles.receiptTitle}>
              {payment.status === "done"
                ? `You paid ${formatCents(payment.amount_cents)} to ${payment.payee}.`
                : `Payment of ${formatCents(payment.amount_cents)} was not sent.`}
            </p>
            <p>
              {payment.message ?? `From ${payment.from}.`} {formatTimestamp(payment.at)}.
            </p>
          </div>
        ) : null}
        <div className="btn-row">
          {heldLines.length ? (
            <button type="button" className="btn btn-primary" onClick={() => setSheet("contact")}>
              Contact the exam payment program
            </button>
          ) : null}
          {!paid && restCents > 0 && adds ? (
            <button type="button" className="btn btn-secondary" onClick={() => setSheet("pay")}>
              Pay the rest from {account.nickname}
            </button>
          ) : null}
        </div>
        {restCents > 0 ? (
          <p className={styles.choice}>
            Paying the rest is your choice. Those lines are medical care the program can pay you back for, and they are
            already in your claim.
          </p>
        ) : null}
      </section>

      {heldLines.length ? (
        <ContactSheet
          open={sheet === "contact"}
          onClose={() => setSheet(null)}
          law={law}
          bill={bill}
          heldCents={heldCents}
        />
      ) : null}
      <PaySheet
        open={sheet === "pay"}
        onClose={() => setSheet(null)}
        billId={bill.bill_id}
        itemIds={payLines.map((l) => l.item_id)}
        amountCents={restCents}
        payee={bill.provider}
        account={account}
        forText={`${payLines.map((l) => l.description).join(", ")}${bill.account_ref ? ` (account ${bill.account_ref})` : ""}`}
        notPaidText={
          heldLines.length
            ? `${heldLines.map((l) => l.description).join(", ")}, ${formatCents(heldCents)}. It stays held.`
            : null
        }
        onDone={addPayment}
      />
    </div>
  );
}

export default function BillScreen() {
  return (
    <FlowGate>
      {(session) => (
        <ContentNote
          id="bill"
          title="This page shows a hospital bill"
          note={
            <p>
              One of its lines is for a forensic exam. Tend shows the law beside it and does not show any medical
              details beyond the bill&apos;s own line names.
            </p>
          }
          action="Show the bill"
        >
          <BillView session={session} />
        </ContentNote>
      )}
    </FlowGate>
  );
}
