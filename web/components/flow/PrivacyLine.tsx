"use client";

import { useState } from "react";
import { useI18n, type Dict, type Formatters } from "@/lib/i18n";
import { useFlow } from "./FlowProvider";
import FlowSheet from "./FlowSheet";
import type { SentEvent } from "./state";
import styles from "./shell.module.css";

// The one line on every screen that says where the survivor's data is. It changes only when
// something actually left the device because they chose to send it.
export function privacyText(sent: SentEvent[], t: Dict, f: Formatters): string {
  if (!sent.length) return t.privacy.quiet;
  const count = (k: SentEvent["kind"]) => sent.filter((e) => e.kind === k).length;
  const parts = [
    count("payment") ? t.privacy.partPayment(count("payment")) : null,
    count("share") ? t.privacy.partShare(count("share")) : null,
    count("bank") ? t.privacy.partBank : null,
    count("server_engine") ? t.privacy.partServer : null,
  ].filter((p): p is string => Boolean(p));
  return t.privacy.sent(f.and(parts));
}

export function sentLine(e: SentEvent, t: Dict, f: Formatters): string {
  const when = f.time(e.at);
  if (e.kind === "payment") return t.privacy.eventPayment(f.money(e.amount_cents ?? 0), e.to ?? "", when);
  if (e.kind === "share") return t.privacy.eventShare(when);
  if (e.kind === "bank") return t.privacy.eventBank(when);
  return t.privacy.eventServer(when);
}

function Shield() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className={styles.privacyIcon}>
      <path
        d="M8 1.5L13.5 3.6V7.6C13.5 10.9 11.3 13.5 8 14.5C4.7 13.5 2.5 10.9 2.5 7.6V3.6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M5.6 8.1L7.3 9.8L10.6 6.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export default function PrivacyLine() {
  const { t, f } = useI18n();
  const { state } = useFlow();
  const [open, setOpen] = useState(false);
  const text = privacyText(state.sent, t, f);

  return (
    <div className={styles.privacy} data-sent={state.sent.length > 0 || undefined}>
      <div className={`page ${styles.privacyInner}`}>
        <Shield />
        <p role="status" className={styles.privacyText}>
          {text}
        </p>
        <button
          type="button"
          className={styles.privacyMore}
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          title={t.privacy.more}
        >
          <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
            <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8 7.2V11.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
          </svg>
          <span className={styles.privacyMoreText}>{t.privacy.more}</span>
        </button>
      </div>
      <FlowSheet open={open} onClose={() => setOpen(false)} title={t.privacy.sheetTitle}>
        <ul className={styles.facts}>
          {t.privacy.facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
        <section className={styles.sentList} aria-labelledby="sent-title">
          <h3 id="sent-title">{t.privacy.sentTitle}</h3>
          {state.sent.length ? (
            <ol>
              {state.sent.map((e, i) => (
                <li key={`${e.at}-${i}`}>{sentLine(e, t, f)}</li>
              ))}
            </ol>
          ) : (
            <p>{t.privacy.sentNone}</p>
          )}
        </section>
      </FlowSheet>
    </div>
  );
}
