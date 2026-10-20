"use client";

import Link from "next/link";
import { CONTACT } from "@/app/press/fromSanat";
import { useI18n, type Lang } from "@/lib/i18n";
import { useFlow } from "./FlowProvider";
import { useOfflineStatus } from "./offline";
import styles from "./shell.module.css";

// The press kit's link. Its words stay here so lib/i18n stays as it is, as with components/bank/strings.ts.
// /press is in English only, so the Spanish says so (the escape keeps this file ASCII).
const PRESS: Record<Lang, { link: string; after: string }> = {
  en: { link: "Press kit", after: " for reporters." },
  es: { link: "Kit de prensa", after: " para periodistas, en ingl\u00e9s." },
};

// The footer holds the link until Sanat sets a contact address: a press kit no reporter can write back
// from reads as unfinished. /press itself still loads.
export default function AppFooter({ pressLink = Boolean(CONTACT) }: { pressLink?: boolean }) {
  const { t, lang } = useI18n();
  const { claim } = useFlow();
  const backend = claim.evaluation?.backend;
  const offline = useOfflineStatus();
  return (
    <footer className={`${styles.footer} no-print`}>
      <div className={`page ${styles.footerInner}`}>
        <p className={styles.help}>
          {t.shell.helpBefore} <a href="tel:18006564673">800-656-4673</a>
          {t.shell.helpAfter}
        </p>
        <p className="meta">{t.shell.demoNote}</p>
        {pressLink ? (
          <p className="meta">
            <Link href="/press" hrefLang="en">
              {PRESS[lang].link}
            </Link>
            {PRESS[lang].after}
          </p>
        ) : null}
        {backend ? (
          <p className="meta" title={claim.evaluation?.detail}>
            {backend === "wasm" ? t.engine.onDevice : t.engine.onServer}
          </p>
        ) : null}
        {offline !== "online" ? (
          <p className="meta" role="status">
            {offline === "offline" ? t.engine.offlineNow : t.engine.offlineReady}
          </p>
        ) : null}
      </div>
    </footer>
  );
}
