"use client";

import { useEffect, useRef, useState } from "react";
import Sheet from "@/components/Sheet";
import { confirmPayment, proposePayment } from "@/lib/api";
import { formatTimestamp } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import type { PaymentRecord } from "@/lib/session";
import type { AccountRef, ActionProposal } from "@/lib/types";
import styles from "./bill.module.css";

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
  onDone: (record: PaymentRecord) => void;
}

type Phase = "proposing" | "ready" | "confirming" | "done" | "error";

export function accountLabel(from: string | AccountRef): string {
  return typeof from === "string" ? from : `${from.nickname} ending ${from.mask ?? from.id.slice(-4)}`;
}

export default function PaySheet(props: PaySheetProps) {
  const { open, onClose, itemIds, amountCents, forText, notPaidText, onDone } = props;
  const [phase, setPhase] = useState<Phase>("proposing");
  const [proposal, setProposal] = useState<(ActionProposal & { demo: boolean }) | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PaymentRecord | null>(null);
  // A proposal is made once per opening, from the props at that moment.
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
    proposePayment(
      {
        bill_id: p.billId,
        item_ids: p.itemIds,
        amount_cents: p.amountCents,
        from_account_id: p.account.id,
        payee: p.payee,
      },
      accountLabel(p.account),
    )
      .then((p) => {
        if (!live) return;
        setProposal(p);
        setPhase("ready");
      })
      .catch((e: Error) => {
        if (!live) return;
        setError(e.message);
        setPhase("error");
      });
    return () => {
      live = false;
    };
  }, [open]);

  async function confirm() {
    if (!proposal || code.length !== 6) return;
    setPhase("confirming");
    setError(null);
    try {
      const r = await confirmPayment(proposal.action_id, code);
      const record: PaymentRecord = {
        ...r,
        item_ids: itemIds,
        payee: proposal.payee,
        from: accountLabel(proposal.from),
      };
      setResult(record);
      setPhase("done");
      onDone(record);
    } catch (e) {
      setError((e as Error).message);
      setPhase("ready");
    }
  }

  const sent = result?.status === "done";
  const footer =
    phase === "done" ? (
      <div className="btn-row">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Done
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
          {phase === "confirming" ? "Paying" : `Pay ${formatCents(proposal?.amount_cents ?? amountCents)}`}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
    );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={phase === "done" ? "Payment result" : "Pay the rest of this bill"}
      footer={footer}
    >
      {phase === "proposing" ? <p className="meta">Preparing the payment details</p> : null}

      {phase === "error" ? (
        <p role="alert" className={styles.problem}>
          Tend could not prepare this payment: {error}
        </p>
      ) : null}

      {proposal && phase !== "done" && phase !== "proposing" && phase !== "error" ? (
        <>
          <dl className={styles.terms}>
            <div>
              <dt>Amount</dt>
              <dd className={styles.termAmount}>{formatCents(proposal.amount_cents)}</dd>
            </div>
            <div>
              <dt>From</dt>
              <dd>{accountLabel(proposal.from)}</dd>
            </div>
            <div>
              <dt>To</dt>
              <dd>{proposal.payee}</dd>
            </div>
            <div>
              <dt>For</dt>
              <dd>{forText}</dd>
            </div>
            {notPaidText ? (
              <div>
                <dt>Not paid</dt>
                <dd>{notPaidText}</dd>
              </div>
            ) : null}
          </dl>

          {proposal.demo ? (
            <p className={styles.demo}>
              Demo mode: Tend is not connected to the bank, so nothing will be sent. The steps are the same.
            </p>
          ) : null}

          <div className={styles.codeBox}>
            <p>To confirm on purpose, type this code:</p>
            <p className={styles.code}>
              <span aria-hidden="true">
                {proposal.confirm_code.slice(0, 3)} {proposal.confirm_code.slice(3)}
              </span>
              <span className="visually-hidden">{proposal.confirm_code.split("").join(" ")}</span>
            </p>
            <label htmlFor="confirm-code" className={styles.codeLabel}>
              Confirmation code
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
              The code works once and expires {formatTimestamp(proposal.expires_at)}.
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
            {sent ? `Paid ${formatCents(result.amount_cents)}.` : "Nothing was sent."}
          </p>
          {result.message ? <p>{result.message}</p> : null}
          <dl className={styles.terms}>
            <div>
              <dt>From</dt>
              <dd>{result.from}</dd>
            </div>
            <div>
              <dt>To</dt>
              <dd>{result.payee}</dd>
            </div>
            {result.nessie_id ? (
              <div>
                <dt>Bank record</dt>
                <dd>
                  <code>{result.nessie_id}</code>
                </dd>
              </div>
            ) : null}
            {result.read_back_matches != null ? (
              <div>
                <dt>Checked with the bank</dt>
                <dd>
                  {result.read_back_matches
                    ? "The bank's record matches this payment"
                    : "The bank's record does not match. Contact the bank."}
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}
    </Sheet>
  );
}
