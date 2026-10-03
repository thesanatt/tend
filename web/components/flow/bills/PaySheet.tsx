"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n, type Dict, type Formatters } from "@/lib/i18n";
import type { AccountRef, ActionProposal } from "@/lib/types";
import FlowSheet from "../FlowSheet";
import { useFlow } from "../FlowProvider";
import { accountLabel } from "../services";
import type { PaymentRecord } from "../state";
import styles from "../flow.module.css";

interface PaySheetProps {
  open: boolean;
  onClose: () => void;
  billId: string;
  itemIds: string[];
  amountCents: number;
  payee: string;
  account: AccountRef;
  forText: string;
  notPaidText: string | null;
}

type Phase = "proposing" | "ready" | "confirming" | "done" | "error";

// The service names the account by id or by label; the survivor sees the label they know.
export function fromLabel(from: ActionProposal["from"], account: AccountRef): string {
  if (typeof from !== "string") return accountLabel(from);
  return from === account.id ? accountLabel(account) : from;
}

// The confirm step shows the payment service's numbers, so they must be the ones the bill showed.
export function proposalProblem(
  p: ActionProposal,
  amountCents: number,
  payee: string,
  t: Dict,
  f: Formatters,
  account?: AccountRef,
): string | null {
  if (p.amount_cents !== amountCents) return t.pay.amountMismatch(f.money(p.amount_cents), f.money(amountCents));
  if (p.payee !== payee) return t.pay.payeeMismatch(p.payee);
  if (account) {
    const from = typeof p.from === "string" ? p.from : p.from.id;
    if (from !== account.id && from !== accountLabel(account)) return t.pay.accountMismatch;
  }
  return null;
}

// Money moves only after the survivor sees the exact amount, account, and payee, and types the
// six-digit code. A payment the bank takes is the first thing that changes the privacy line.
export default function PaySheet(props: PaySheetProps) {
  const { open, onClose, itemIds, amountCents, forText, notPaidText } = props;
  const { t, f } = useI18n();
  const { services, dispatch, logSent } = useFlow();
  const [phase, setPhase] = useState<Phase>("proposing");
  const [proposal, setProposal] = useState<(ActionProposal & { demo: boolean }) | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PaymentRecord | null>(null);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    if (!open) return;
    let live = true;
    const p = latest.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase("proposing");
    setCode("");
    setError(null);
    setResult(null);
    services
      .propose({ bill_id: p.billId, amount_cents: p.amountCents, from: p.account, payee: p.payee })
      .then((proposal) => {
        if (!live) return;
        const problem = proposalProblem(proposal, p.amountCents, p.payee, t, f, p.account);
        if (problem) {
          setError(problem);
          setPhase("error");
          return;
        }
        setProposal(proposal);
        setPhase("ready");
      })
      .catch((e: Error) => {
        if (!live) return;
        setError(t.pay.prepareFailed(e.message));
        setPhase("error");
      });
    return () => {
      live = false;
    };
    // A proposal is made once per opening, from the props at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function confirm() {
    if (!proposal || code.length !== 6) return;
    setPhase("confirming");
    setError(null);
    try {
      const r = await services.confirm(proposal.action_id, code);
      const from = fromLabel(proposal.from, latest.current.account);
      const record: PaymentRecord = {
        action_id: r.action_id,
        bill_id: latest.current.billId,
        item_ids: itemIds,
        amount_cents: r.amount_cents,
        payee: proposal.payee,
        from,
        status: r.status,
        message: r.message,
        nessie_id: r.nessie_id ?? null,
        read_back_matches: r.read_back_matches ?? null,
        demo: proposal.demo,
        at: r.at,
      };
      setResult(record);
      setPhase("done");
      dispatch({ type: "payment", record });
      if (r.status === "done") {
        dispatch({ type: "billChoice", billId: record.bill_id, choice: "pay" });
        if (!proposal.demo) logSent({ kind: "payment", amount_cents: r.amount_cents, to: proposal.payee });
      }
    } catch (e) {
      // The bank side answers in English; the survivor reads it in their language.
      const status = (e as { status?: number }).status;
      setError(
        status === 400 ? t.pay.codeWrong : status === 410 ? t.pay.codeExpired : t.pay.confirmFailed((e as Error).message),
      );
      setPhase("ready");
    }
  }

  const sent = result?.status === "done";
  const footer =
    phase === "done" ? (
      <div className="btn-row">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          {t.common.done}
        </button>
      </div>
    ) : (
      <div className="btn-row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={phase !== "ready" || code.length !== 6}
          onClick={confirm}
        >
          {phase === "confirming" ? t.pay.paying : t.pay.pay(f.money(proposal?.amount_cents ?? amountCents))}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onClose}>
          {t.common.cancel}
        </button>
      </div>
    );

  return (
    <FlowSheet open={open} onClose={onClose} title={phase === "done" ? t.pay.resultTitle : t.pay.title} footer={footer}>
      {phase === "proposing" ? (
        <p className="meta" role="status">
          {t.pay.preparing}
        </p>
      ) : null}

      {phase === "error" ? (
        <p role="alert" className={styles.problem}>
          {error}
        </p>
      ) : null}

      {proposal && (phase === "ready" || phase === "confirming") ? (
        <>
          <dl className={styles.terms}>
            <div>
              <dt>{t.pay.amount}</dt>
              <dd className={styles.termAmount}>{f.money(proposal.amount_cents)}</dd>
            </div>
            <div>
              <dt>{t.pay.from}</dt>
              <dd>{fromLabel(proposal.from, props.account)}</dd>
            </div>
            <div>
              <dt>{t.pay.to}</dt>
              <dd>{proposal.payee}</dd>
            </div>
            <div>
              <dt>{t.pay.forLabel}</dt>
              <dd>{forText}</dd>
            </div>
            {notPaidText ? (
              <div>
                <dt>{t.pay.notPaid}</dt>
                <dd>{notPaidText}</dd>
              </div>
            ) : null}
          </dl>

          <p className={styles.demoNote}>{proposal.demo ? t.pay.demoNote : t.pay.nessieNote}</p>

          <div className={styles.codeBox}>
            <p>{t.pay.codeIntro}</p>
            <p className={styles.code}>
              <span aria-hidden="true">
                {proposal.confirm_code.slice(0, 3)} {proposal.confirm_code.slice(3)}
              </span>
              <span className="visually-hidden">{proposal.confirm_code.split("").join(" ")}</span>
            </p>
            <label htmlFor="confirm-code" className={styles.fieldLabel}>
              {t.pay.codeLabel}
            </label>
            <input
              id="confirm-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className={styles.codeInput}
              aria-describedby="code-expiry"
            />
            <p id="code-expiry" className="meta">
              {t.pay.codeExpiry(f.time(proposal.expires_at))}
            </p>
            {error ? (
              <p role="alert" className={styles.problem}>
                {error}
              </p>
            ) : null}
          </div>
        </>
      ) : null}

      {phase === "done" && result ? (
        <div className={styles.result} role="status">
          <p className={styles.resultTitle}>{sent ? t.pay.resultPaid(f.money(result.amount_cents)) : t.pay.resultNotSent}</p>
          {result.demo ? <p>{t.pay.demoResult}</p> : result.message ? <p>{result.message}</p> : null}
          <dl className={styles.terms}>
            <div>
              <dt>{t.pay.from}</dt>
              <dd>{result.from}</dd>
            </div>
            <div>
              <dt>{t.pay.to}</dt>
              <dd>{result.payee}</dd>
            </div>
            {result.nessie_id ? (
              <div>
                <dt>{t.pay.bankRecord}</dt>
                <dd>
                  <code>{result.nessie_id}</code>
                </dd>
              </div>
            ) : null}
            {result.read_back_matches != null ? (
              <div>
                <dt>{t.pay.readBack}</dt>
                <dd>{result.read_back_matches ? t.pay.readBackOk : t.pay.readBackBad}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}
    </FlowSheet>
  );
}
