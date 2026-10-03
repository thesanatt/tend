import type { ReactNode } from "react";
import { statusCopy } from "@/lib/status";
import styles from "./StatusTag.module.css";

const SHAPES: Record<string, ReactNode> = {
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
};

export default function StatusTag({ status, label }: { status: string; label?: string }) {
  return (
    <span className={`${styles.tag} ${styles[status] ?? ""}`}>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        {SHAPES[status] ?? SHAPES.unknown_rule}
      </svg>
      {label ?? statusCopy(status).label}
    </span>
  );
}
