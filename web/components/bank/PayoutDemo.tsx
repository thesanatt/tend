"use client";

// Track's demo of the program paying. One tap asks the demo bank (Nessie, through the Tend API) for a
// deposit from the state's program into the fictional account, for what the claim asks for now, and the
// plants for the costs it covers bloom. It is labeled a demo everywhere it shows, and it promises nothing:
// the program decides what it pays. It appears only when the flow used the demo bank.
import { useState } from "react";
import { plants } from "@/components/flow/claim";
import { useFlow } from "@/components/flow/FlowProvider";
import { useI18n } from "@/lib/i18n";
import type { Jurisdiction } from "@/lib/types";
import { useLaw } from "@/lib/useLaw";
import {
  activePayout,
  bankApi,
  demoPaid,
  demoPersona,
  PAYOUT_DONE,
  PAYOUT_PREFIX,
  PAYOUT_UNDONE,
  type BankApi,
} from "./api";
import styles from "./bank.module.css";
import { BANK_TEXT } from "./strings";

export function DemoPaidNote({ className }: { className?: string }) {
  const { lang } = useI18n();
  return <p className={className}>{BANK_TEXT[lang].payout.plant}</p>;
}

export function isDemoPaid(state: Parameters<typeof demoPaid>[0], itemId: string): boolean {
  return demoPaid(state, itemId);
}

// The program as a bank statement names the payer, the same way the server does (api/tend_api/payout.py).
export function programName(law: Pick<Jurisdiction, "name" | "program"> | null | undefined): string | null {
  if (!law) return null;
  const state = (law.name ?? "").trim();
  const program = (law.program?.program_name ?? "Crime Victim Compensation").trim();
  return state && !program.toLowerCase().includes(state.toLowerCase()) ? `${state} ${program}` : program;
}

export default function PayoutDemo({ api = bankApi }: { api?: BankApi }) {
  const { lang, t, f } = useI18n();
  const s = BANK_TEXT[lang];
  const { state, claim, dispatch, today, logSent } = useFlow();
  const law = useLaw(state.check.st || null);
  const [busy, setBusy] = useState<"pay" | "undo" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const persona = demoPersona(state);
  const output = claim.evaluation?.output.jurisdiction === state.check.st ? claim.evaluation.output : null;
  if (!persona || !output) return null;

  const garden = plants(state, output);
  const amount = output.totals.allowed_cents;
  const active = activePayout(state.payments);

  async function pay() {
    if (!persona || !output) return;
    setBusy("pay");
    setError(null);
    try {
      const live = (await api.mode()) === "live";
      const result = live ? await api.payout(persona, { st: state.check.st, amount_cents: amount }) : null;
      if (result) logSent({ kind: "payment", amount_cents: result.amount_cents, to: s.payout.to });
      const ids = garden.filter((p) => !state.life[p.item.item_id]?.paid_at).map((p) => p.item.item_id);
      dispatch({ type: "life", ids, patch: { paid_at: today } });
      dispatch({
        type: "payment",
        record: {
          action_id: `${PAYOUT_PREFIX}${result?.deposit_id ?? "local"}`,
          bill_id: "",
          item_ids: ids,
          amount_cents: result?.amount_cents ?? amount,
          payee: result?.program ?? programName(law.law) ?? "",
          from: result ? `${result.account.nickname} ${result.account.mask ?? ""}`.trim() : "",
          status: PAYOUT_DONE,
          nessie_id: result?.deposit_id ?? null,
          read_back_matches: result?.read_back_matches ?? null,
          demo: true,
          at: new Date().toISOString(),
        },
      });
    } catch (e) {
      setError(s.payout.failed((e as Error).message));
    } finally {
      setBusy(null);
    }
  }

  async function undo() {
    if (!persona || !active) return;
    setBusy("undo");
    setError(null);
    try {
      if (active.nessie_id) await api.undoPayout(persona);
      dispatch({ type: "life", ids: active.item_ids, patch: { paid_at: undefined } });
      dispatch({ type: "payment", record: { ...active, status: PAYOUT_UNDONE, at: new Date().toISOString() } });
    } catch (e) {
      setError(s.payout.failed((e as Error).message));
    } finally {
      setBusy(null);
    }
  }

  // Nessie keeps whole dollars, so a claim with cents gets the dollars below it.
  const floored = amount - (amount % 100);
  const note =
    active && active.nessie_id && active.amount_cents !== amount
      ? active.amount_cents === floored
        ? s.payout.whole(f.money(active.amount_cents), f.money(amount))
        : s.payout.claimNow(f.money(amount))
      : null;

  return (
    <section className={styles.payout} aria-labelledby="payout-title">
      <h2 id="payout-title" className={styles.payoutTitle}>
        {s.payout.title}
        <span className={styles.tag}>{s.demoTag}</span>
      </h2>
      {active ? (
        <div className={styles.payoutResult} role="status">
          <p className={styles.payoutDone}>
            {s.payout.done(f.money(active.amount_cents), active.payee || s.payout.theProgram)}
          </p>
          <p className="meta">{active.nessie_id ? s.payout.bank(active.nessie_id) : s.payout.local}</p>
          {note ? <p className="meta">{note}</p> : null}
          <p>{s.payout.decides}</p>
          <div className="btn-row">
            <button type="button" className="btn btn-quiet" disabled={busy !== null} onClick={undo}>
              {busy === "undo" ? s.payout.undoing : s.payout.undo}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p>{s.payout.lead}</p>
          {amount > 0 ? (
            <p className="meta">
              {s.payout.amount(f.money(amount))} {t.common.programDecides}
            </p>
          ) : (
            <p className="meta">{s.payout.nothing}</p>
          )}
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" disabled={busy !== null || amount <= 0} onClick={pay}>
              {busy === "pay" ? s.payout.working : s.payout.button}
            </button>
          </div>
        </>
      )}
      {error ? (
        <p role="alert" className={styles.problem}>
          {error}
        </p>
      ) : null}
    </section>
  );
}
