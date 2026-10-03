"use client";

import { useI18n } from "@/lib/i18n";
import { useFlow } from "./FlowProvider";
import styles from "./shell.module.css";

export default function AppFooter() {
  const { t } = useI18n();
  const { claim } = useFlow();
  const backend = claim.evaluation?.backend;
  return (
    <footer className={`${styles.footer} no-print`}>
      <div className={`page ${styles.footerInner}`}>
        <p className={styles.help}>
          {t.shell.helpBefore} <a href="tel:18006564673">800-656-4673</a>
          {t.shell.helpAfter}
        </p>
        <p className="meta">{t.shell.demoNote}</p>
        {backend ? (
          <p className="meta" title={claim.evaluation?.detail}>
            {backend === "wasm" ? t.engine.onDevice : t.engine.onServer}
          </p>
        ) : null}
      </div>
    </footer>
  );
}
