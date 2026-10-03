"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { hasProgress, useFlow } from "./FlowProvider";
import PrivacyLine from "./PrivacyLine";
import styles from "./shell.module.css";

export const FLOW_PATHS = ["/check", "/gather", "/packet", "/track"];

function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <path d="M12 21V11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      <path d="M12 12.5C11.2 8.6 7.6 6.3 4 6.6C4.4 10.6 8 13 12 12.5Z" fill="currentColor" />
      <path d="M12 10C12.6 6.4 15.8 3.8 19.6 4C19.4 7.8 16 10.4 12 10Z" fill="currentColor" opacity="0.72" />
      <path d="M7 21H17" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function LanguageSwitch() {
  const { lang, setLang, t } = useI18n();
  const other = lang === "en" ? "es" : "en";
  return (
    <button
      type="button"
      className={styles.lang}
      lang={other}
      onClick={() => setLang(other)}
      title={t.shell.switchTo}
    >
      {t.shell.otherLanguage}
    </button>
  );
}

export default function AppHeader() {
  const { t } = useI18n();
  const { state } = useFlow();
  const path = usePathname() ?? "/";
  const inFlow = FLOW_PATHS.some((p) => path.startsWith(p));
  const started = hasProgress(state);

  return (
    <header className={`${styles.header} no-print`}>
      <div className={`page ${styles.inner}`}>
        <Link href="/" className={styles.brand}>
          <Mark className={styles.mark} />
          <span>Tend</span>
        </Link>
        <nav aria-label={t.shell.navLabel} className={styles.nav}>
          <Link href="/" aria-current={path === "/" || path.startsWith("/law") ? "page" : undefined}>
            {t.shell.navLaw}
          </Link>
          <Link href={started ? "/gather" : "/check"} aria-current={inFlow ? "page" : undefined}>
            {started ? t.shell.navResume : t.shell.navStart}
          </Link>
          <LanguageSwitch />
        </nav>
      </div>
      <PrivacyLine />
    </header>
  );
}
