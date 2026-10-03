"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n";
import { ExitControl } from "./ExitControl";
import styles from "./sheet.module.css";

interface FlowSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  tone?: "default" | "held";
}

// Bottom sheet on phones, side panel from 900px. Native <dialog> traps focus and closes on Esc; the
// sheet repeats Exit this page because a modal makes the corner button unreachable.
export default function FlowSheet({ open, onClose, title, children, footer, tone = "default" }: FlowSheetProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open, mounted]);

  if (!mounted) return null;

  return createPortal(
    <dialog
      ref={ref}
      className={`${styles.sheet} ${tone === "held" ? styles.held : ""}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {/* A closed sheet keeps only its frame: long lists hold many citations, and their quotes
          are built when one opens. */}
      {open ? (
        <div className={styles.panel}>
          <header className={styles.head}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            <div className={styles.headActions}>
              <button type="button" className={`btn btn-quiet ${styles.close}`} onClick={onClose}>
                {t.common.close}
              </button>
              <ExitControl inline />
            </div>
          </header>
          <div className={styles.body}>{children}</div>
          {footer ? <footer className={styles.foot}>{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>,
    document.body,
  );
}
