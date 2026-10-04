"use client";

// The bank records behind the demo, for anyone checking the work (a Capital One judge, an advocate): every
// Nessie record Tend read or wrote for the fictional account, each with its Nessie id; the balance added up
// term by term against Nessie's frozen balance field; the bill against the payment that paid it and the line
// still held; and the API calls behind the view. It reads the bank only when asked, which the privacy line
// records, and it appears only when the flow used the demo bank. The server shows only fictional demo data.
import { useState } from "react";
import { useFlow } from "@/components/flow/FlowProvider";
import Money from "@/components/Money";
import { useI18n } from "@/lib/i18n";
import {
  bankApi,
  demoPersona,
  type Activity,
  type ActivityAccount,
  type ActivityBill,
  type ActivityRecord,
  type BankApi,
  type RecordKind,
} from "./api";
import styles from "./bank.module.css";
import { BANK_TEXT, type BankText } from "./strings";

const KINDS: RecordKind[] = ["purchase", "deposit", "withdrawal", "transfer"];

type View =
  { status: "closed" | "loading" | "local" } | { status: "error"; error: string } | { status: "ready"; data: Activity };

function Check({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return (
    <p className={styles.check} data-ok={ok || undefined}>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        {ok ? (
          <circle cx="6" cy="6" r="5" fill="currentColor" />
        ) : (
          <>
            <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M2.5 9.5L9.5 2.5" stroke="currentColor" strokeWidth="1.4" />
          </>
        )}
      </svg>
      {ok ? yes : no}
    </p>
  );
}

function Signed({ cents, sign }: { cents: number; sign: 1 | -1 }) {
  return (
    <span className={styles.signed}>
      {sign > 0 ? "+" : "-"}
      <Money cents={cents} />
    </span>
  );
}

function AccountLedger({ account, s }: { account: ActivityAccount; s: BankText["activity"] }) {
  const ledger = account.ledger;
  const title = `${account.nickname} ${account.mask ?? ""}`.trim();
  return (
    <article className={styles.card} aria-labelledby={`acct-${account.id}`}>
      <h3 id={`acct-${account.id}`} className={styles.cardTitle}>
        {title}
      </h3>
      <p className={styles.id}>
        {s.id} <code>{account.id}</code>
      </p>
      <table className={styles.sum}>
        <caption className="visually-hidden">{s.computed}</caption>
        <tbody>
          <tr>
            <th scope="row">
              {s.opening}
              <span className={styles.sub}>{s.openingNote}</span>
            </th>
            <td>
              <Money cents={ledger.opening_cents} />
            </td>
          </tr>
          {ledger.terms
            .filter((term) => term.count > 0)
            .map((term) => (
              <tr key={term.key}>
                <th scope="row">{s.term(term.key, term.count)}</th>
                <td>
                  <Signed cents={term.cents} sign={term.sign} />
                </td>
              </tr>
            ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">{s.computed}</th>
            <td>
              <Money cents={ledger.computed_cents} />
            </td>
          </tr>
        </tfoot>
      </table>
      <Check ok={ledger.reconciled} yes={s.addsUp} no={s.noMatch} />
      {ledger.not_counted ? <p className="meta">{s.notCounted(ledger.not_counted)}</p> : null}
      {account.not_shown ? <p className="meta">{s.notShown(account.not_shown)}</p> : null}
    </article>
  );
}

function BillCheck({ bill, s }: { bill: ActivityBill; s: BankText["activity"] }) {
  const { f } = useI18n();
  return (
    <article className={styles.card} aria-labelledby={`bill-${bill.id}`}>
      <h3 id={`bill-${bill.id}`} className={styles.cardTitle}>
        {s.billTitle(bill.payee)}
      </h3>
      <p className={styles.id}>
        {s.id} <code>{bill.id}</code>
      </p>
      <table className={styles.sum}>
        <caption className="visually-hidden">{s.left}</caption>
        <tbody>
          <tr>
            <th scope="row">{s.itemized}</th>
            <td>
              <Money cents={bill.itemized_total_cents} />
            </td>
          </tr>
          {bill.payments.map((p) => (
            <tr key={p.withdrawal_id}>
              <th scope="row">
                {s.paidBy(p.withdrawal_id, f.and(p.lines.map(String)))}
                <span className={styles.sub}>{f.date(p.date, "short")}</span>
              </th>
              <td>
                <Signed cents={p.amount_cents} sign={-1} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">{s.left}</th>
            <td>
              <Money cents={bill.expected_cents} />
            </td>
          </tr>
        </tfoot>
      </table>
      {bill.in_bank && bill.amount_cents !== null ? (
        <p className={styles.bankSays}>
          <span>{s.bankSays(bill.status ?? "")}</span>
          <Money cents={bill.amount_cents} />
        </p>
      ) : (
        <p>{s.notInBank}</p>
      )}
      {bill.held ? (
        <p className={styles.held}>
          {s.held(bill.held.note ?? `${f.money(bill.held.cents)} (${bill.held.rule_ids[0] ?? ""})`)}
        </p>
      ) : null}
      {bill.nickname ? (
        <p className="meta">{s.nickname(bill.nickname)}</p>
      ) : bill.nickname_changed ? (
        <p className="meta">{s.nicknameChanged}</p>
      ) : null}
      <Check ok={bill.reconciled} yes={s.billMatches} no={s.billDiffers} />
    </article>
  );
}

function describe(r: ActivityRecord, s: BankText["activity"], and: (items: string[]) => string): string {
  if (r.tend?.what === "payment") {
    const to = r.tend.payee ? s.payment(r.tend.payee) : s.paymentElsewhere;
    return r.tend.bill_id ? `${to}. ${s.forBill(and((r.tend.bill_lines ?? []).map(String)))}` : to;
  }
  if (r.tend?.what === "demo_payout") return s.payout(r.tend.program ?? "");
  const words = [r.merchant, r.description].filter(Boolean).join(", ");
  return r.to ? `${words}. ${s.transferTo(r.to)}` : words;
}

function RecordRow({ record, s }: { record: ActivityRecord; s: BankText["activity"] }) {
  const { f } = useI18n();
  return (
    <li className={styles.row}>
      <span className={styles.date}>{f.date(record.date, "short")}</span>
      <span className={styles.what}>
        {describe(record, s, f.and)}
        {record.source === "tend" ? <span className={styles.mark}>{s.tendWrote}</span> : null}
        {record.changed ? <span className={styles.mark}>{s.changed}</span> : null}
        <span className={styles.rid}>
          {record.account ? `${record.account} ` : ""}
          <code>{record.id}</code>
        </span>
      </span>
      <span className={styles.amount}>
        <Signed cents={record.amount_cents} sign={record.kind === "deposit" ? 1 : -1} />
      </span>
    </li>
  );
}

function Records({ data, s }: { data: Activity; s: BankText["activity"] }) {
  const { f } = useI18n();
  const total = KINDS.reduce((n, kind) => n + (data.records[kind]?.length ?? 0), 0);
  return (
    <div className={styles.records}>
      <p className="meta">{data.source === "live" ? s.live(f.time(data.read_at)) : s.saved}</p>
      {data.bank_mode === "dry_run" ? <p className="meta">{s.dryRun}</p> : null}
      <div className={styles.cards}>
        {data.accounts.map((a) => (
          <AccountLedger key={a.id} account={a} s={s} />
        ))}
        {data.bills.map((b) => (
          <BillCheck key={b.id} bill={b} s={s} />
        ))}
      </div>

      <section aria-labelledby="bank-writes">
        <h3 id="bank-writes" className={styles.cardTitle}>
          {s.writesTitle}
        </h3>
        {data.tend_writes.length ? (
          <ul className={styles.rows}>
            {data.tend_writes.map((r) => (
              <RecordRow key={r.id} record={r} s={s} />
            ))}
          </ul>
        ) : (
          <p className="meta">{s.writesNone}</p>
        )}
      </section>

      {data.dry_run_writes.length ? (
        <section aria-labelledby="bank-dry">
          <h3 id="bank-dry" className={styles.cardTitle}>
            {s.dryRunTitle}
          </h3>
          <ul className={styles.rows}>
            {data.dry_run_writes.map((r) => (
              <li key={r.id} className={styles.row}>
                <span className={styles.date}>{r.date ? f.date(r.date, "short") : ""}</span>
                <span className={styles.what}>
                  {r.kind}
                  <span className={styles.rid}>
                    <code>{r.id}</code>
                  </span>
                </span>
                <span className={styles.amount}>
                  {r.amount_cents !== null ? <Money cents={r.amount_cents} /> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <details className={styles.more}>
        <summary>{s.recordsTitle(total)}</summary>
        {KINDS.map((kind) =>
          data.records[kind]?.length ? (
            <details key={kind} className={styles.kind}>
              <summary>{s.kind(kind, data.records[kind].length)}</summary>
              <ul className={styles.rows}>
                {data.records[kind].map((r) => (
                  <RecordRow key={r.id} record={r} s={s} />
                ))}
              </ul>
            </details>
          ) : null,
        )}
      </details>

      <details className={styles.more}>
        <summary>{s.callsTitle(data.calls.length)}</summary>
        <ol className={styles.calls}>
          {data.calls.map((c, i) => (
            <li key={`${c.method}-${c.path}-${i}`}>
              <code>
                {c.method} {c.path}
              </code>{" "}
              <span className="meta">
                {c.status ?? s.noAnswer}, {s.callNote(c.ms, c.count)}
              </span>
            </li>
          ))}
        </ol>
      </details>
      {data.hidden_count ? <p className="meta">{s.notShown(data.hidden_count)}</p> : null}
    </div>
  );
}

export default function BankActivity({ api = bankApi }: { api?: BankApi }) {
  const { lang } = useI18n();
  const text = BANK_TEXT[lang];
  const s = text.activity;
  const { state, logSent } = useFlow();
  const [view, setView] = useState<View>({ status: "closed" });
  const persona = demoPersona(state);
  if (!persona) return null;

  async function load() {
    if (!persona) return;
    setView({ status: "loading" });
    try {
      if ((await api.mode()) !== "live") {
        setView({ status: "local" });
        return;
      }
      const data = await api.activity(persona);
      if (!state.sent.some((e) => e.kind === "bank")) logSent({ kind: "bank" });
      setView({ status: "ready", data });
    } catch (e) {
      setView({ status: "error", error: (e as Error).message });
    }
  }

  return (
    <section className={styles.activity} aria-labelledby="bank-title">
      <div className={styles.activityHead}>
        <h2 id="bank-title" className={styles.payoutTitle}>
          {s.title}
          <span className={styles.tag}>{text.fictionalTag}</span>
        </h2>
        <p className="meta">{s.lead}</p>
        <div className="btn-row">
          {view.status === "ready" ? (
            <>
              <button type="button" className="btn btn-quiet" onClick={load}>
                {s.refresh}
              </button>
              <button type="button" className="btn btn-quiet" onClick={() => setView({ status: "closed" })}>
                {s.hide}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-quiet" disabled={view.status === "loading"} onClick={load}>
              {view.status === "loading" ? s.loading : s.show}
            </button>
          )}
        </div>
      </div>
      {view.status === "local" ? <p role="status">{s.local}</p> : null}
      {view.status === "error" ? (
        <p role="alert" className={styles.problem}>
          {s.failed(view.error)}
        </p>
      ) : null}
      {view.status === "ready" ? <Records data={view.data} s={s} /> : null}
    </section>
  );
}
