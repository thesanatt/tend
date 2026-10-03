"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ExitButton } from "./QuickExit";
import styles from "./Sheet.module.css";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  tone?: "default" | "held";
}

// Bottom sheet on phones, side panel on wide screens. Native <dialog> traps focus and closes on Esc.
// Portaled to <body> so a sheet opened from inline text never nests block content in a paragraph.
export default function Sheet({ open, onClose, title, children, footer, tone = "default" }: SheetProps) {
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
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open, mounted]);

  if (!mounted) return null;

  return createPortal(
    <dialog
      ref={ref}
      className={`${styles.sheet} ${tone === "held" ? styles.held : ""}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className={styles.panel}>
        <header className={styles.head}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <div className={styles.headActions}>
            <button type="button" className={`btn btn-quiet ${styles.close}`} onClick={onClose}>
              Close
            </button>
            <ExitButton />
          </div>
        </header>
        <div className={styles.body}>{children}</div>
        {footer ? <footer className={styles.foot}>{footer}</footer> : null}
      </div>
    </dialog>,
    document.body,
  );
}
