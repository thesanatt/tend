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

// review: only what is on this device. Nothing is sent until the survivor asks for a code.
// dead: the code can no longer be used (expired, used, locked); a new one can be asked for.
// unsure: the bank may have taken it; no new code is offered, so nothing is paid twice.
type Phase = "review" | "proposing" | "ready" | "confirming" | "done" | "error" | "dead" | "unsure";

const statusOf = (e: unknown): number | undefined => {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
};

// Why a proposal failed, in the survivor's language. The service answers in English, so its text is
// never shown as is.
export function proposeProblem(e: unknown, t: Dict): string {
  const status = statusOf(e);
  if (status === 422) return t.pay.wholeDollars;
  if (status === 403) return t.pay.notDemoAccount;
  return t.pay.prepareFailed;
}

// Why a confirm failed, and what the sheet can offer next.
export function confirmProblem(e: unknown, t: Dict): { text: string; phase: "ready" | "dead" | "unsure" } {
  const status = statusOf(e);
  // A wrong code: the demo answers 400, the API 403. The same code can be typed again.
  if (status === 400 || status === 403) return { text: t.pay.codeWrong, phase: "ready" };
  if (status === 410 || status === 409) return { text: t.pay.codeExpired, phase: "dead" };
  if (status === 423) return { text: t.pay.codeLocked, phase: "dead" };
  // Any other refusal from the service came before the bank was asked.
  if (status !== undefined && status >= 400 && status < 500) return { text: t.pay.confirmFailed, phase: "dead" };
  // A bank error or no answer at all: the payment may have gone through.
  return { text: t.pay.bankUnsure, phase: "unsure" };
}

// Money moves only after the survivor sees the exact amount, account, and payee, and types the
// six-digit code. Asking for the code is the first thing that can leave the device, so it waits for a tap.
export default function PaySheet(props: PaySheetProps) {
  const { open, onClose, itemIds, amountCents, forText, notPaidText } = props;
  const { t, f } = useI18n();
  const { services, dispatch, logSent } = useFlow();
  const [phase, setPhase] = useState<Phase>("review");
  const [proposal, setProposal] = useState<(ActionProposal & { demo: boolean }) | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PaymentRecord | null>(null);
  const latest = useRef(props);
  const attempt = useRef(0);
  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    if (!open) return;
    attempt.current += 1;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase("review");
    setProposal(null);
    setCode("");
    setError(null);
    setResult(null);
  }, [open]);

  async function getCode() {
    const id = ++attempt.current;
    const p = latest.current;
    setPhase("proposing");
    setProposal(null);
    setCode("");
    setError(null);
    try {
      const next = await services.propose({
        bill_id: p.billId,
        amount_cents: p.amountCents,
        from: p.account,
        payee: p.payee,
      });
      if (id !== attempt.current) return;
      // The service now holds the amount, account, and payee, whatever happens next.
      if (!next.demo) {
        logSent({ kind: "payment_setup", amount_cents: next.amount_cents, to: next.payee, action_id: next.action_id });
      }
      const problem = proposalProblem(next, p.amountCents, p.payee, t, f, p.account);
      if (problem) {
        setError(problem);
        setPhase("error");
        return;
      }
      setProposal(next);
      setPhase("ready");
    } catch (e) {
      if (id !== attempt.current) return;
      setError(proposeProblem(e, t));
      setPhase("error");
    }
  }

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
      if (r.status === "done") dispatch({ type: "billChoice", billId: record.bill_id, choice: "pay" });
      // "unverified" reached the bank too, even though its record does not match.
      if (!proposal.demo && (r.status === "done" || r.status === "unverified")) {
        logSent({ kind: "payment", amount_cents: r.amount_cents, to: proposal.payee, action_id: proposal.action_id });
      }
    } catch (e) {
      const next = confirmProblem(e, t);
      setError(next.text);
      setPhase(next.phase);
      if (next.phase === "unsure" && !proposal.demo) {
        logSent({
          kind: "payment",
          amount_cents: proposal.amount_cents,
          to: proposal.payee,
          action_id: proposal.action_id,
        });
        dispatch({
          type: "payment",
          record: {
            action_id: proposal.action_id,
            bill_id: latest.current.billId,
            item_ids: itemIds,
            amount_cents: proposal.amount_cents,
            payee: proposal.payee,
            from: fromLabel(proposal.from, latest.current.account),
            status: "unverified",
            demo: false,
            at: new Date().toISOString(),
          },
        });
      }
    }
  }

  const sent = result?.status === "done";
  const unverified = result?.status === "unverified";
  const footer =
    phase === "done" || phase === "unsure" ? (
      <div className="btn-row">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          {t.common.done}
        </button>
      </div>
    ) : phase === "review" || phase === "proposing" || phase === "dead" ? (
      <div className="btn-row">
        <button type="button" className="btn btn-primary" disabled={phase === "proposing"} onClick={getCode}>
          {phase === "proposing" ? t.pay.preparing : phase === "dead" ? t.pay.newCode : t.pay.getCode}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onClose}>
          {t.common.cancel}
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

      {phase === "review" ? (
        <>
          <dl className={styles.terms}>
            <div>
              <dt>{t.pay.amount}</dt>
              <dd className={styles.termAmount}>{f.money(amountCents)}</dd>
            </div>
            <div>
              <dt>{t.pay.from}</dt>
              <dd>{accountLabel(props.account)}</dd>
            </div>
            <div>
              <dt>{t.pay.to}</dt>
              <dd>{props.payee}</dd>
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
          <p className={styles.demoNote}>{t.pay.reviewNote}</p>
        </>
      ) : null}

      {phase === "error" || phase === "dead" || phase === "unsure" ? (
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
          <p className={styles.resultTitle}>
            {sent
              ? t.pay.resultPaid(f.money(result.amount_cents))
              : unverified
                ? t.pay.resultUnverified
                : t.pay.resultNotSent}
          </p>
          {/* The bank service writes its note in English. */}
          {result.demo ? <p>{t.pay.demoResult}</p> : result.message ? <p lang="en">{result.message}</p> : null}
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
