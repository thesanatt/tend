"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { offline } from "@/lib/netlog";
import type { EngineInput, EngineOutput } from "@/lib/types";
import { useFlow } from "../FlowProvider";
import { shareProblem } from "../problems";
import styles from "../flow.module.css";

const HOURS = [24, 72, 168] as const;

export function expired(expiresAt: string, now = Date.now()): boolean {
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at <= now;
}

// Share with an advocate: the packet is sealed in this browser, and only the link opens it.
export default function ShareBox({ input, output }: { input: EngineInput; output: EngineOutput }) {
  const { t, f } = useI18n();
  const { services, state, dispatch, logSent } = useFlow();
  const [hours, setHours] = useState<(typeof HOURS)[number]>(72);
  const [once, setOnce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // A link past its expiry opens nothing, so it is not offered for copying.
  const active = state.shares.filter((s) => !s.revoked && !expired(s.expires_at));

  async function make() {
    setBusy(true);
    setError(null);
    try {
      const created_at = new Date().toISOString();
      const sealed: { url: string; id: string; expires_at?: string | null } = await services.share.seal(
        { st: state.check.st, created_at, input, output },
        { expires_hours: hours, once },
      );
      // The server's expiry when it gives one; the one asked for otherwise.
      const expires_at = sealed.expires_at ?? new Date(Date.now() + hours * 3_600_000).toISOString();
      dispatch({ type: "share", record: { id: sealed.id, url: sealed.url, expires_at, once, revoked: false } });
      logSent({ kind: "share", ref: `share:${sealed.id}` });
    } catch (err) {
      // Offline, the locked packet never left; the button stays so the survivor can try again.
      setError(offline() ? t.share.offline : shareProblem(err, t));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      await services.share.revoke(id);
      dispatch({ type: "revokeShare", id });
    } catch {
      setError(offline() ? t.share.revokeOffline : t.share.revokeFailed);
    }
  }

  return (
    <div className={styles.stack}>
      {active.map((s) => (
        <div key={s.id} className={styles.shareLink}>
          <label htmlFor={`share-${s.id}`} className={styles.fieldLabel}>
            {t.share.ready}
          </label>
          <input id={`share-${s.id}`} type="text" readOnly value={s.url} onFocus={(e) => e.target.select()} />
          <p className="meta">
            {t.share.expires(f.time(s.expires_at))}
            {s.once ? ` ${t.share.onceNote}` : ""}
          </p>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(s.url);
                  setCopied(s.id);
                } catch {
                  setCopied(null);
                }
              }}
            >
              {copied === s.id ? t.common.copied : t.share.copy}
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => revoke(s.id)}>
              {t.share.revoke}
            </button>
          </div>
        </div>
      ))}
      {state.shares.some((s) => s.revoked) ? <p className="meta">{t.share.revoked}</p> : null}
      {state.shares.some((s) => !s.revoked && expired(s.expires_at)) ? <p className="meta">{t.share.lapsed}</p> : null}

      {!active.length ? (
        <>
          <div className={styles.field}>
            <label htmlFor="share-hours" className={styles.fieldLabel}>
              {t.share.expiryLabel}
            </label>
            <select
              id="share-hours"
              value={hours}
              onChange={(e) => setHours(Number(e.target.value) as (typeof HOURS)[number])}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {t.share.hours[h]}
                </option>
              ))}
            </select>
          </div>
          <label className={styles.checkLine}>
            <input type="checkbox" checked={once} onChange={(e) => setOnce(e.target.checked)} />
            {t.share.once}
          </label>
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={make}>
              {busy ? t.share.making : t.share.make}
            </button>
          </div>
        </>
      ) : null}
      {error ? (
        <p role="alert" className={styles.problem}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
