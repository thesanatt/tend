"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import Checks from "@/components/claim/Checks";
import Citation from "@/components/Citation";
import FlowGate from "@/components/FlowGate";
import Money from "@/components/Money";
import { createShare, dataMode, packetUrl, type DataMode } from "@/lib/api";
import { formatDay, formatTimestamp, todayIso } from "@/lib/dates";
import { BACKEND_LABEL } from "@/lib/engine";
import { expenseLabel, expenseRank } from "@/lib/expenses";
import { formatCents } from "@/lib/money";
import { engineInputFrom, useSession, type Session } from "@/lib/session";
import STATES from "@/lib/states.json";
import { useLaw } from "@/lib/useLaw";
import styles from "@/components/claim/claim.module.css";

const stateName = (st: string) => STATES.find((s) => s.st === st)?.name ?? st;
// Conduct rules stay in the law view, quoted in full. On this screen they would read as blame.
const GOOD_TO_KNOW = ["eligible_crime", "collateral_source", "emergency_award", "residency"];

function ClaimView({ session }: { session: Session }) {
  const { claim, updateLife, setJurisdiction, setShare } = useSession();
  const law = useLaw(session.st);
  const [mode, setMode] = useState<DataMode | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  useEffect(() => {
    dataMode().then(setMode);
  }, []);

  const evaluation = claim.evaluation;
  const output = evaluation?.output;
  if (!output) {
    return claim.status === "error" ? (
      <p role="alert" className={styles.problem}>
        Tend could not check this claim against the law: {claim.error}
      </p>
    ) : (
      <p className="meta">Checking the law</p>
    );
  }

  const eligible = output.lines.filter((l) => l.status === "eligible");
  const filedAt = eligible.map((l) => session.life[l.item_id]?.filed_at).find(Boolean);
  const byExpense = Object.entries(output.totals.by_expense)
    .filter(([, cents]) => typeof cents === "number")
    .sort(([a], [b]) => expenseRank(a) - expenseRank(b));
  const pdf = mode ? packetUrl(output.claim_id, mode) : null;
  const infoRules = GOOD_TO_KNOW.map((c) => law.byCategory(c).find((r) => output.info_rule_ids.includes(r.id))).filter(
    (r): r is NonNullable<typeof r> => Boolean(r),
  );

  async function share() {
    setSharing(true);
    setShareError(null);
    try {
      setShare(await createShare(engineInputFrom(session), output!));
    } catch (e) {
      setShareError((e as Error).message);
    } finally {
      setSharing(false);
    }
  }

  return (
    <div className={styles.claim}>
      <section className={styles.total} aria-live="polite">
        <h1 className={styles.totalLabel}>Amount you can ask for. The program decides.</h1>
        <p className={styles.totalFigure}>
          <Money cents={output.totals.allowed_cents} face="inherit" />
        </p>
        <p className={styles.totalNote}>
          Under {stateName(output.jurisdiction)} law, from {eligible.length} eligible{" "}
          {eligible.length === 1 ? "cost" : "costs"}.
          {output.totals.held_cents > 0 ? (
            <>
              {" "}
              Held separately: <span className={styles.held}>{formatCents(output.totals.held_cents)}</span> on a bill
              you should not pay.
            </>
          ) : null}
        </p>
      </section>

      <section aria-labelledby="checks-title" className={styles.section}>
        <h2 id="checks-title">Checks</h2>
        <Checks checks={output.checks} law={law} policeReport={session.police_report} />
      </section>

      <section aria-labelledby="parts-title" className={styles.section}>
        <h2 id="parts-title">What makes up the amount</h2>
        <table className={styles.parts}>
          <thead>
            <tr>
              <th scope="col">Kind of cost</th>
              <th scope="col" className={styles.num}>
                Costs
              </th>
              <th scope="col" className={styles.num}>
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {byExpense.map(([expense, cents]) => (
              <tr key={expense}>
                <th scope="row">{expenseLabel(expense)}</th>
                <td className={styles.num}>{eligible.filter((l) => l.expense === expense).length}</td>
                <td className={styles.num}>
                  <Money cents={cents as number} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={2}>
                Total
              </th>
              <td className={styles.num}>
                <Money cents={output.totals.allowed_cents} />
              </td>
            </tr>
          </tfoot>
        </table>
        <p className="meta">
          <Link replace href="/ledger">
            Back to the costs
          </Link>{" "}
          to answer questions or change an answer.
        </p>
      </section>

      <section aria-labelledby="packet-title" className={`${styles.section} ${styles.split}`}>
        <div>
          <h2 id="packet-title">Your claim packet</h2>
          <p>
            The packet lists each cost with the transaction it came from and the exact sentence of law behind it, ready
            to send with {stateName(output.jurisdiction)}&apos;s application form.
          </p>
        </div>
        <div className={styles.stack}>
          {pdf ? (
            <a href={pdf} className="btn btn-primary">
              Download the packet (PDF)
            </a>
          ) : (
            <Link href="/claim/packet" className="btn btn-primary">
              Open the printable packet
            </Link>
          )}
          {law.law?.program.application_pdf_url ? (
            <a href={law.law.program.application_pdf_url} target="_blank" rel="noopener noreferrer">
              The program&apos;s application form
              <span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="share-title" className={`${styles.section} ${styles.split}`}>
        <div>
          <h2 id="share-title">Share with an advocate</h2>
          <p>
            An advocate can see this claim without seeing your bank account. The link is read-only and stops working
            after a week.
          </p>
        </div>
        <div className={styles.stack}>
          {session.share ? (
            <div className={styles.shareBox}>
              <p>
                <Link href={session.share.url}>
                  {session.share.demo ? "Open the demo advocate view" : "Open the shared view"}
                </Link>
              </p>
              <p className="meta">
                {session.share.demo ? "Demo link with fictional data. " : ""}Expires{" "}
                {formatTimestamp(session.share.expires_at)}.
              </p>
            </div>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={share} disabled={sharing}>
              {sharing ? "Making the link" : "Make a read-only link"}
            </button>
          )}
          {shareError ? (
            <p role="alert" className={styles.problem}>
              {shareError}
            </p>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="sent-title" className={`${styles.section} ${styles.split}`}>
        <div>
          <h2 id="sent-title">When you send it</h2>
          <p>
            Tend does not file anything. When you send the claim to the program yourself, mark it here and each plant in
            your garden starts to bud.
          </p>
        </div>
        <div className={styles.stack}>
          {filedAt ? (
            <>
              <p className={styles.sent}>You marked this claim as sent on {formatDay(filedAt)}.</p>
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  updateLife(
                    eligible.map((l) => l.item_id),
                    { filed_at: undefined },
                  )
                }
              >
                Undo
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={eligible.length === 0}
              onClick={() =>
                updateLife(
                  eligible.map((l) => l.item_id),
                  { filed_at: todayIso() },
                )
              }
            >
              I sent my claim to the program
            </button>
          )}
          <Link replace href="/garden">
            See your garden
          </Link>
        </div>
      </section>

      <section aria-labelledby="compare-title" className={`${styles.section} ${styles.split}`}>
        <div>
          <h2 id="compare-title">The same costs under another state&apos;s law</h2>
          <p>
            A claim belongs to the state where it happened. To see how the law changes the result, pick another state.
            Your costs stay the same.
          </p>
        </div>
        <div className={styles.stack}>
          <label htmlFor="compare" className={styles.compareLabel}>
            Law applied
          </label>
          <select id="compare" value={session.st} onChange={(e) => setJurisdiction(e.target.value)}>
            {[...STATES]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((s) => (
                <option key={s.st} value={s.st}>
                  {s.name}
                </option>
              ))}
          </select>
        </div>
      </section>

      {infoRules.length ? (
        <section aria-labelledby="know-title" className={styles.section}>
          <h2 id="know-title">Good to know</h2>
          <ul className={styles.know}>
            {infoRules.map((r) => (
              <li key={r.id}>
                <p>{r.summary}</p>
                <Citation
                  ruleIds={[r.id]}
                  status="eligible"
                  law={law}
                  subject={r.summary}
                  title="The rule"
                  explain="Shown for your information. It does not change the amount."
                />
              </li>
            ))}
          </ul>
          <p className="meta">
            Tend never asks about or screens on anything you did. The program makes its own review.
          </p>
        </section>
      ) : null}

      <details className={styles.audit}>
        <summary>How Tend worked this out</summary>
        <div className={styles.auditBody}>
          <p>
            Math by: {evaluation ? BACKEND_LABEL[evaluation.backend] : ""}
            {evaluation?.detail ? ` (${evaluation.detail})` : ""}. Law image SHA-256{" "}
            <code className={styles.sha}>{output.law_image_sha256}</code>
          </p>
          <p>
            The engine made {output.trace.length} decisions, in order. Every amount comes from these steps, using only
            verified rules.
          </p>
          <div className={styles.traceWrap}>
            <table className={styles.trace}>
              <thead>
                <tr>
                  <th scope="col">Step</th>
                  <th scope="col">Item</th>
                  <th scope="col">Rule</th>
                  <th scope="col" className={styles.num}>
                    Change
                  </th>
                </tr>
              </thead>
              <tbody>
                {output.trace.map((t, i) => (
                  <tr key={i}>
                    <td>{t.op}</td>
                    <td>{t.item_id ? t.item_id.replace(/^nessie:/, "").slice(-8) : ""}</td>
                    <td>{t.rule_id ?? ""}</td>
                    <td className={styles.num}>{t.delta_cents ? formatCents(t.delta_cents) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>
    </div>
  );
}

export default function ClaimScreen() {
  return <FlowGate>{(session) => <ClaimView session={session} />}</FlowGate>;
}
