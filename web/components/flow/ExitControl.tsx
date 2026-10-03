"use client";

import { useEffect, useRef } from "react";
import { DOUBLE_PRESS_MS, leaveNow, onPageShow } from "@/components/QuickExit";
import { useI18n } from "@/lib/i18n";
import { useOptionalFlow } from "./FlowProvider";
import styles from "./shell.module.css";

// Exit this page: the corner button, Esc twice, and a copy inside every sheet. It locks the vault,
// blanks the screen, clears the tab, and replaces the history entry (components/QuickExit.tsx).
export function ExitControl({ inline = false }: { inline?: boolean }) {
  const { t } = useI18n();
  const flow = useOptionalFlow();
  const lastEsc = useRef(-Infinity);
  const leave = () => {
    try {
      flow?.services.vault.lock();
    } finally {
      leaveNow();
    }
  };
  const leaveRef = useRef(leave);
  useEffect(() => {
    leaveRef.current = leave;
  });

  useEffect(() => {
    if (inline) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.repeat) return;
      const now = performance.now();
      if (now - lastEsc.current < DOUBLE_PRESS_MS) leaveRef.current();
      else lastEsc.current = now;
    };
    // Capture phase, so an open dialog cannot swallow the second press.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [inline]);

  const button = (
    <button type="button" className={styles.exit} onClick={leave}>
      {t.shell.exit}
    </button>
  );
  if (inline) return button;
  return (
    <div className={`${styles.exitWrap} no-print`}>
      {button}
      <span className={styles.exitHint} aria-hidden="true">
        {t.shell.exitHintBefore} <kbd>Esc</kbd> {t.shell.exitHintAfter}
      </span>
    </div>
  );
}
