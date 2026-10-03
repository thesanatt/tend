"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import { hasProgress, useFlow } from "./FlowProvider";
import { openProblem } from "./problems";
import SaveSheet from "./SaveSheet";
import styles from "./flow.module.css";

const STEPS = [
  { href: "/check", key: "check" },
  { href: "/gather", key: "gather" },
  { href: "/packet", key: "packet" },
  { href: "/track", key: "track" },
] as const;

function SaveStatus() {
  const { t } = useI18n();
  const { vault, lockNow, state } = useFlow();
  const [open, setOpen] = useState(false);
  const unsaved = hasProgress(state);
  if (vault.status === "open") {
    return (
      <p className={styles.saveStatus}>
        <span>{t.vault.savedHere}</span>
        <button type="button" className="link-button" onClick={() => lockNow()}>
          {t.vault.lock}
        </button>
      </p>
    );
  }
  return (
    <p className={styles.saveStatus}>
      {unsaved ? <span>{t.vault.notSaved}</span> : null}
      <button type="button" className={`btn btn-quiet ${styles.saveButton}`} onClick={() => setOpen(true)}>
        {t.vault.save}
      </button>
      <SaveSheet open={open} onClose={() => setOpen(false)} />
    </p>
  );
}

export function Steps() {
  const { t } = useI18n();
  const path = usePathname() ?? "";
  return (
    <div className={`${styles.stepsBar} no-print`}>
      <nav aria-label={t.steps.label} className={styles.steps}>
        <ol>
          {STEPS.map((s, i) => {
            const current = path === s.href || path.startsWith(`${s.href}/`);
            return (
              <li key={s.href}>
                <Link replace href={s.href} aria-current={current ? "step" : undefined}>
                  <span className={styles.stepN} aria-hidden="true">
                    {i + 1}
                  </span>
                  {t.steps[s.key]}
                </Link>
              </li>
            );
          })}
        </ol>
      </nav>
      <SaveStatus />
    </div>
  );
}

// Saved progress is locked until the survivor opens it. Until then, a flow page offers to open it,
// start over without it, or delete it.
function Resume({ onSkip }: { onSkip: () => void }) {
  const { t } = useI18n();
  const { openSaved, forget, vault } = useFlow();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const withPasskey = vault.methods ? vault.methods.passkey : vault.passkey === true;
  const withPasscode = vault.methods ? vault.methods.passphrase : true;

  async function open(opts: { passkey?: boolean; passphrase?: string }) {
    setBusy(true);
    setError(null);
    try {
      const ok = await openSaved(opts);
      if (!ok) setError(opts.passkey ? t.vault.passkeyFailed : t.vault.wrong);
    } catch (err) {
      setError(openProblem(err, t));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (code) open({ passphrase: code });
  }

  return (
    <section className={styles.resume} aria-labelledby="resume-title">
      <h1 id="resume-title">{t.vault.resumeTitle}</h1>
      {vault.idleLocked ? <p className={styles.note}>{t.vault.idle}</p> : null}
      <p className="lead">{t.vault.resumeLead}</p>
      {withPasskey ? (
        <div className="btn-row">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => open({ passkey: true })}>
            {t.vault.openPasskey}
          </button>
        </div>
      ) : null}
      {withPasscode ? (
        <form className={styles.stack} onSubmit={submit}>
          <label htmlFor="resume-passcode" className={styles.fieldLabel}>
            {t.vault.passcodeLabel}
          </label>
          <div className={styles.inline}>
            <input
              id="resume-passcode"
              type="password"
              autoComplete="current-password"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className={styles.passcode}
              aria-describedby={error ? "resume-error" : undefined}
            />
            <button type="submit" className="btn btn-secondary" disabled={busy || !code}>
              {t.vault.open}
            </button>
          </div>
        </form>
      ) : null}
      {vault.methods && (!withPasskey || !withPasscode) ? (
        <p className="meta">
          {t.vault.savedOnly(vault.methods.passkey ? t.vault.methodPasskey : t.vault.methodPasscode)}
        </p>
      ) : null}
      {error ? (
        <p id="resume-error" role="alert" className={styles.problem}>
          {error}
        </p>
      ) : null}
      <div className={styles.resumeOther}>
        <button type="button" className="link-button" onClick={onSkip}>
          {t.vault.startOver}
        </button>
        {confirmDelete ? (
          <div className={styles.confirmBox} role="group" aria-labelledby="delete-q">
            <p id="delete-q">{t.vault.deleteConfirm}</p>
            <div className="btn-row">
              <button type="button" className="btn btn-quiet" onClick={() => forget()}>
                {t.vault.deleteYes}
              </button>
              <button type="button" className="link-button" onClick={() => setConfirmDelete(false)}>
                {t.common.cancel}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="link-button" onClick={() => setConfirmDelete(true)}>
            {t.vault.delete}
          </button>
        )}
      </div>
    </section>
  );
}

// Every flow page has the same neutral tab title, so a screen reader hears nothing new when the
// step changes. Moving focus to the new page's heading tells it where it is.
function useFocusHeadingOnStep() {
  const path = usePathname();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const h1 = document.querySelector<HTMLElement>("main h1");
    if (!h1) return;
    h1.tabIndex = -1;
    h1.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [path]);
}

export default function FlowFrame({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { vault, state } = useFlow();
  const [skipped, setSkipped] = useState(false);
  // Once progress is open again, a later lock (Lock now, or the quiet-time lock) offers it again.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (vault.status === "open") setSkipped(false);
  }, [vault.status]);
  const locked = vault.status === "locked" && !hasProgress(state) && !skipped;
  useFocusHeadingOnStep();

  return (
    <div className="page">
      <Steps />
      {vault.status === "checking" ? (
        <p className="meta" style={{ paddingBlock: "var(--space-7)" }}>
          {t.common.loading}
        </p>
      ) : locked ? (
        <Resume onSkip={() => setSkipped(true)} />
      ) : (
        children
      )}
    </div>
  );
}
