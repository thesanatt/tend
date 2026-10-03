"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "@/lib/session";
import styles from "./SiteHeader.module.css";

const FLOW = ["/start", "/ledger", "/bill", "/claim", "/garden"];

export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <path d="M12 21V11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      <path d="M12 12.5C11.2 8.6 7.6 6.3 4 6.6C4.4 10.6 8 13 12 12.5Z" fill="currentColor" />
      <path d="M12 10C12.6 6.4 15.8 3.8 19.6 4C19.4 7.8 16 10.4 12 10Z" fill="currentColor" opacity="0.72" />
      <path d="M7 21H17" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export default function SiteHeader() {
  const path = usePathname();
  const { session } = useSession();
  const inFlow = FLOW.some((p) => path.startsWith(p));
  const flow = session ? { href: "/ledger", label: "Your claim" } : { href: "/start", label: "Start a check" };

  return (
    <header className={`${styles.header} no-print`}>
      <div className={`page ${styles.inner}`}>
        <Link href="/" className={styles.brand}>
          <Mark className={styles.mark} />
          <span>Tend</span>
        </Link>
        <nav aria-label="Main" className={styles.nav}>
          <Link href="/" aria-current={path === "/" || path.startsWith("/law") ? "page" : undefined}>
            Law garden
          </Link>
          <Link href={flow.href} aria-current={inFlow ? "page" : undefined}>
            {flow.label}
          </Link>
        </nav>
      </div>
    </header>
  );
}
