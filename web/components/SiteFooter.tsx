"use client";

import { useEffect, useState } from "react";
import { dataMode, type DataMode } from "@/lib/api";
import { BACKEND_LABEL } from "@/lib/engine";
import { useSession } from "@/lib/session";
import styles from "./SiteFooter.module.css";

export default function SiteFooter() {
  const { claim } = useSession();
  const [mode, setMode] = useState<DataMode | null>(null);

  useEffect(() => {
    dataMode().then(setMode);
  }, []);

  const evaluation = claim.evaluation;
  return (
    <footer className={`${styles.footer} no-print`}>
      <div className={`page ${styles.inner}`}>
        <p className={styles.help}>
          If you are in danger, call 911. To talk with someone now, call the National Sexual Assault Hotline at{" "}
          <a href="tel:18006564673">800-656-4673</a>, any time.
        </p>
        <p className="meta">
          Demo data is fictional. The bank is Capital One&apos;s Nessie, a mock bank, so no real money exists here. Tend
          is not legal advice. The program decides every claim.
        </p>
        <p className={`meta ${styles.status}`} aria-live="polite">
          <span>
            Data: {mode === null ? "checking" : mode === "live" ? "Tend API and Nessie" : "built-in demo fixtures"}
          </span>
          {evaluation ? <span title={evaluation.detail}>Claim math: {BACKEND_LABEL[evaluation.backend]}</span> : null}
        </p>
      </div>
    </footer>
  );
}
