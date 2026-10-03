"use client";

import { useI18n } from "@/lib/i18n";
import { useFlow } from "./FlowProvider";
import styles from "./flow.module.css";

// The law engine runs on this device. When it cannot, Tend asks before using its server, because
// that would send the answers and costs off the device.
export default function EngineNotice() {
  const { t } = useI18n();
  const { claim, allowServer } = useFlow();

  if (claim.status === "needs_consent") {
    return (
      <div className={styles.consent} role="group" aria-labelledby="consent-title">
        <h3 id="consent-title">{t.engine.consentTitle}</h3>
        <p>{t.engine.consentBody}</p>
        <div className="btn-row">
          <button type="button" className="btn btn-secondary" onClick={allowServer}>
            {t.engine.consentYes}
          </button>
        </div>
        <p className="meta">{t.engine.consentNo}</p>
      </div>
    );
  }
  if (claim.status === "error") {
    return (
      <p role="alert" className={styles.problem}>
        {t.engine.error}
        {claim.error ? <span className={styles.detail}> {claim.error}</span> : null}
      </p>
    );
  }
  if (claim.status === "computing" && !claim.evaluation) {
    return (
      <p className="meta" role="status">
        {t.engine.computing}
      </p>
    );
  }
  return null;
}
