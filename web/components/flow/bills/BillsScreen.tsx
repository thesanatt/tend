"use client";

import Link from "next/link";
import { useState } from "react";
import Money from "@/components/Money";
import type { Letter } from "@/lib/contracts";
import { useI18n, type Dict } from "@/lib/i18n";
import type { Rule } from "@/lib/types";
import { useLaw, type LawIndex } from "@/lib/useLaw";
import { billItems, billPlan } from "../claim";
import Cite from "../Cite";
import EngineNotice from "../EngineNotice";
import { useFlow } from "../FlowProvider";
import LawQuote from "../LawQuote";
import LetterSheet from "../LetterSheet";
import { accountLabel } from "../services";
import type { BillRecord } from "../state";
import StatusMark from "../StatusMark";
import { usePacket } from "../usePacket";
import styles from "../flow.module.css";
import PaySheet from "./PaySheet";

// Used when the packet builder has no billing letter: the same request, built from the verified rule.
export function fallbackHoldLetter(
  t: Dict,
  stateName: string,
  provider: string,
  heldText: string,
  noBill: Rule,
  payer: string | null,
): Letter {
  return {
    kind: "billing_hold",
    title: t.letters.billing_hold,
    body: t.letters.holdBody(provider, heldText, stateName, noBill.pinpoint, noBill.quote, payer),
    rule_ids: [noBill.id],
  };
}

function Unreliable({ bill }: { bill: BillRecord }) {
  const { t } = useI18n();
  const { preview } = useFlow();
  const url = preview(bill.id);
  const isPdf = /\.pdf$/i.test(bill.label);
  return (
    <article className={styles.billCard} aria-labelledby={`bill-${bill.id}`}>
      <h2 id={`bill-${bill.id}`} className={styles.billTitle}>
        {t.bills.unreliableTitle}
      </h2>
      <p>{t.bills.unreliableBody}</p>
      {url ? (
        isPdf ? (
          <p>
            <a href={url} target="_blank" rel="noopener noreferrer">
              {t.bills.openOriginal(bill.label)}
              <span className="visually-hidden"> {t.common.newTab}</span>
            </a>
          </p>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={t.bills.originalAlt(bill.label)} className={styles.original} />
        )
      ) : (
        <p className="meta">{bill.label}</p>
      )}
    </article>
  );
}

function Triage({ bill, law }: { bill: BillRecord; law: LawIndex }) {
  const { t, f } = useI18n();
  const { state, claim, dispatch } = useFlow();
  const [sheet, setSheet] = useState<"letter" | "pay" | null>(null);
  const output = claim.evaluation?.output.jurisdiction === state.check.st ? claim.evaluation.output : null;
  const plan = billPlan(state, bill, output);
  const items = billItems(state, bill);
  const lines = new Map(output?.lines.map((l) => [l.item_id, l]));
  const provider = bill.reading.provider ?? bill.label;
  const pk = usePacket(sheet === "letter");
  const noBill = law.byCategory("exam_no_bill")[0];
  const payRule = law.byCategory("exam_payment").find((r) => typeof r.params?.payer === "string");
  const payer = typeof payRule?.params?.payer === "string" ? payRule.params.payer : null;
  const heldText = plan.held.map((i) => `${i.description}, ${f.money(i.amount_cents)}`).join("; ");
  const letter =
    pk.packet?.letters.find((l) => l.kind === "billing_hold") ??
    ((pk.status === "ready" || pk.status === "error") && noBill
      ? fallbackHoldLetter(t, law.law?.name ?? "", provider, heldText, noBill, payer)
      : null);
  const payments = state.payments.filter((p) => p.bill_id === bill.id);
  const paid = payments.find((p) => p.status === "done");
  const lastTry = payments.at(-1);
  const program = law.law?.program;

  return (
    <article className={styles.billBlock} aria-labelledby={`bill-${bill.id}`}>
      <div className={styles.billCard}>
        <header className={styles.billHead}>
          <p className={styles.provider}>
            {provider}
            {bill.sample ? <span className={styles.tag}>{t.common.fictional}</span> : null}
          </p>
          <h2 id={`bill-${bill.id}`} className={styles.billTitle}>
            {t.bills.itemized}
          </h2>
        </header>
        <table className={styles.billTable}>
          <caption className="visually-hidden">{t.bills.caption}</caption>
          <thead>
            <tr>
              <th scope="col">{t.bills.lineCol}</th>
              <th scope="col">{t.bills.serviceCol}</th>
              <th scope="col" className={styles.num}>
                {t.bills.amountCol}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const status = lines.get(it.item_id)?.status ?? "checking";
              const held = status === "held";
              return (
                <tr key={it.item_id} className={held ? styles.heldRow : undefined}>
                  <td className={styles.lineNo}>{it.line_no}</td>
                  <td>
                    <span className={styles.service}>{it.description}</span>
                    <span className={styles.lineStatus}>
                      <StatusMark status={status} />
                      {held ? <span className={styles.heldWhy}>{t.bills.heldWhy}</span> : null}
                    </span>
                  </td>
                  <td className={styles.num}>
                    <Money cents={it.amount_cents} struck={held} className={held ? styles.heldAmount : undefined} />
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={2}>
                {t.bills.total}
              </th>
              <td className={styles.num}>
                <Money cents={bill.reading.total_cents ?? 0} />
              </td>
            </tr>
            {plan.heldCents > 0 ? (
              <tr className={styles.heldTotal}>
                <th scope="row" colSpan={2}>
                  {t.bills.heldTotal}
                </th>
                <td className={styles.num}>
                  <Money cents={-plan.heldCents} />
                </td>
              </tr>
            ) : null}
            {plan.decided ? (
              <tr className={styles.restRow}>
                <th scope="row" colSpan={2}>
                  {t.bills.rest}
                </th>
                <td className={styles.num}>
                  <Money cents={plan.restCents} />
                </td>
              </tr>
            ) : null}
          </tfoot>
        </table>
        <p className="meta">{t.bills.adds(items.length)}</p>
      </div>

      {!plan.decided ? (
        <div className={styles.billSide}>
          <EngineNotice />
          <p role="status">{t.bills.checking}</p>
        </div>
      ) : (
        <div className={styles.billSide}>
          {plan.held.length ? (
            <section className={styles.holdBox} aria-labelledby={`hold-${bill.id}`}>
              <h3 id={`hold-${bill.id}`}>{t.bills.dontPayTitle}</h3>
              <ul className={styles.heldList}>
                {plan.held.map((i) => (
                  <li key={i.item_id}>
                    {t.bills.dontPayLine(i.description, f.money(i.amount_cents), law.law?.name ?? "")}
                  </li>
                ))}
              </ul>
              {noBill ? <LawQuote rule={noBill} source={law.source(noBill.source_id)} /> : null}
              {plan.heldRuleIds.length > 1 ? (
                <p className="meta">
                  {t.bills.allRules(plan.heldRuleIds.length)}{" "}
                  <Cite ruleIds={plan.heldRuleIds} law={law} subject={heldText} tone="held" />
                </p>
              ) : null}
              <div className="btn-row">
                <button type="button" className="btn btn-primary" onClick={() => setSheet("letter")}>
                  {t.bills.letterButton}
                </button>
              </div>
              <div className={styles.whoPays}>
                <h4>{t.bills.whoPays}</h4>
                <p>{payer ?? t.bills.whoPaysUnknown}</p>
                {program?.phone ? (
                  <p>
                    {program.program_name}:{" "}
                    <a href={`tel:${program.phone.replace(/[^\d+]/g, "")}`}>{program.phone}</a>
                  </p>
                ) : null}
                {payRule ? <Cite ruleIds={[payRule.id]} law={law} subject={t.bills.whoPays} /> : null}
              </div>
            </section>
          ) : (
            <section className={styles.holdBox} data-none>
              <h3>{t.bills.noHoldTitle}</h3>
              <p>{noBill ? t.bills.noHoldExam : t.bills.noHoldRule(law.law?.name ?? "")}</p>
            </section>
          )}

          {plan.restCents > 0 ? (
            <section className={styles.restBox} aria-labelledby={`rest-${bill.id}`}>
              <h3 id={`rest-${bill.id}`}>{t.bills.restTitle(f.money(plan.restCents))}</h3>
              {paid ? (
                <p className={styles.done} role="status">
                  {t.bills.paid(f.money(paid.amount_cents), paid.payee, f.time(paid.at))}
                </p>
              ) : (
                <>
                  <p>{t.bills.eitherWay}</p>
                  {plan.repayable.length ? (
                    <ul className={styles.repayable}>
                      {plan.repayable.map((i) => (
                        <li key={i.item_id}>
                          {i.description}, {f.money(i.amount_cents)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {lastTry && lastTry.status !== "done" ? (
                    <p className={styles.note}>{t.bills.notSent(f.money(lastTry.amount_cents))}</p>
                  ) : null}
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={!state.account}
                      onClick={() => setSheet("pay")}
                    >
                      {t.bills.payNow(f.money(plan.restCents), state.account ? accountLabel(state.account) : "")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      aria-pressed={bill.choice === "claim"}
                      onClick={() =>
                        dispatch({ type: "billChoice", billId: bill.id, choice: bill.choice === "claim" ? null : "claim" })
                      }
                    >
                      {t.bills.leaveUnpaid}
                    </button>
                  </div>
                  {!state.account ? <p className="meta">{t.bills.payNeedsBank}</p> : null}
                  {bill.choice === "claim" ? (
                    <p className={styles.done} role="status">
                      {t.bills.choseClaim}
                    </p>
                  ) : null}
                </>
              )}
            </section>
          ) : null}
        </div>
      )}

      <LetterSheet open={sheet === "letter"} onClose={() => setSheet(null)} letter={letter} law={law} tone="held" />
      {state.account && plan.decided && plan.restCents > 0 ? (
        <PaySheet
          open={sheet === "pay"}
          onClose={() => setSheet(null)}
          billId={bill.id}
          itemIds={plan.rest.map((i) => i.item_id)}
          amountCents={plan.restCents}
          payee={provider}
          account={state.account}
          forText={plan.rest.map((i) => i.description).join(", ")}
          notPaidText={plan.held.length ? t.pay.notPaidText(heldText) : null}
        />
      ) : null}
    </article>
  );
}

export default function BillsScreen() {
  const { t } = useI18n();
  const { state } = useFlow();
  const law = useLaw(state.check.st || null);
  const resolved = state.bills.every((b) => b.reading.status !== "ok" || b.choice !== null);

  return (
    <div className={styles.bills}>
      <header className={styles.screenHead}>
        <p className={styles.back}>
          <Link replace href="/gather">
            {t.bills.back}
          </Link>
        </p>
        <h1>{t.bills.title}</h1>
        <p className="lead">{t.bills.lead}</p>
      </header>
      {!state.bills.length ? (
        <p className={styles.emptyNote}>
          {t.bills.none} <Link href="/gather">{t.bills.toGather}</Link>
        </p>
      ) : (
        state.bills.map((b) =>
          b.reading.status === "ok" ? <Triage key={b.id} bill={b} law={law} /> : <Unreliable key={b.id} bill={b} />,
        )
      )}
      <div className={styles.nextRow}>
        <Link href="/packet" className={`btn ${resolved ? "btn-primary" : "btn-secondary"}`}>
          {t.gather.nextPacket}
        </Link>
      </div>
    </div>
  );
}
