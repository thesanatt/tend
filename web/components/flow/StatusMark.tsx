"use client";

import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import type { RowStatus } from "./claim";
import styles from "./flow.module.css";

// Each status has its own shape and a word, never color alone (web/DESIGN.md).
const SHAPES: Record<RowStatus, ReactNode> = {
  eligible: <circle cx="6" cy="6" r="4.5" fill="currentColor" />,
  held: <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="currentColor" />,
  excluded: (
    <>
      <circle cx="6" cy="6" r="4.3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 9L9 3" stroke="currentColor" strokeWidth="1.4" />
    </>
  ),
  needs_confirmation: (
    <circle cx="6" cy="6" r="4.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2.2 1.6" />
  ),
  unknown_rule: <circle cx="6" cy="6" r="4.3" fill="none" stroke="currentColor" strokeWidth="1.4" />,
  out_of_window: <path d="M2 6H10" stroke="currentColor" strokeWidth="1.6" />,
  declined: <path d="M2 6H10" stroke="currentColor" strokeWidth="1.6" />,
  replaced: <path d="M2 4H10M2 8H10" stroke="currentColor" strokeWidth="1.4" />,
  checking: <circle cx="6" cy="6" r="1.6" fill="currentColor" />,
};

export default function StatusMark({ status }: { status: RowStatus }) {
  const { t } = useI18n();
  return (
    <span className={styles.status} data-status={status}>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        {SHAPES[status]}
      </svg>
      {t.status[status]}
    </span>
  );
}
