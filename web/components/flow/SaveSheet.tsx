"use client";

import { useState, type FormEvent } from "react";
import { useI18n } from "@/lib/i18n";
import { useFlow } from "./FlowProvider";
import FlowSheet from "./FlowSheet";
import styles from "./flow.module.css";

export const MIN_PASSCODE = 6;

// Pause and resume: progress goes into the encrypted vault on this device, behind Touch ID (a
// passkey) or a passcode. Nothing is sent anywhere.
export default function SaveSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { save, services } = useFlow();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"passkey" | "passcode" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const short = code.length < MIN_PASSCODE;

  async function run(kind: "passkey" | "passcode") {
    setBusy(kind);
    setError(null);
    try {
      await save(kind === "passkey" ? { passkey: true } : { passphrase: code });
      setCode("");
      onClose();
    } catch (err) {
      setError(t.vault.failed((err as Error).message));
    } finally {
      setBusy(null);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (!short) run("passcode");
  }

  return (
    <FlowSheet open={open} onClose={onClose} title={t.vault.sheetTitle}>
      <p>{t.vault.sheetLead}</p>
      {services.passkeySupported() ? (
        <div className={styles.stack}>
          <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => run("passkey")}>
            {busy === "passkey" ? t.vault.saving : t.vault.passkey}
          </button>
          <p className="meta">{t.vault.passkeyHint}</p>
        </div>
      ) : null}
      <form className={styles.stack} onSubmit={submit} noValidate>
        <label htmlFor="save-passcode" className={styles.fieldLabel}>
          {services.passkeySupported() ? t.vault.orPasscode : t.vault.passcodeLabel}
        </label>
        <p id="save-passcode-hint" className="meta">
          {t.vault.passcodeHint(MIN_PASSCODE)}
        </p>
        <input
          id="save-passcode"
          type="password"
          autoComplete="new-password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-describedby={tried && short ? "save-passcode-hint save-passcode-error" : "save-passcode-hint"}
          aria-invalid={tried && short}
          className={styles.passcode}
        />
        {tried && short ? (
          <p id="save-passcode-error" className={styles.problem}>
            {t.vault.passcodeShort(MIN_PASSCODE)}
          </p>
        ) : null}
        <div className="btn-row">
          <button type="submit" className="btn btn-secondary" disabled={busy !== null}>
            {busy === "passcode" ? t.vault.saving : t.vault.savePasscode}
          </button>
        </div>
      </form>
      {error ? (
        <p role="alert" className={styles.problem}>
          {error}
        </p>
      ) : null}
    </FlowSheet>
  );
}
