"use client";

// Cloud AI, only after a yes (docs/PRIVACY.md item 3). One screen says exactly what would leave this
// device, who gets it, and what stays. The answer starts as no: nothing is sent until the survivor
// taps yes, and saying no keeps Tend's built-in rules working.
import { useI18n } from "@/lib/i18n";
import FlowSheet from "./FlowSheet";
import styles from "./flow.module.css";

export type CloudAsk = { kind: "rows"; rows: number } | { kind: "bill"; label: string };

export default function CloudConsent({
  ask,
  onNo,
  onYes,
}: {
  ask: CloudAsk | null;
  onNo: () => void;
  onYes: () => void;
}) {
  const { t } = useI18n();
  const c = t.cloud;
  const rows = ask?.kind === "rows";
  return (
    <FlowSheet
      open={ask !== null}
      onClose={onNo}
      title={rows ? c.titleRows : c.titleBill}
      footer={
        <div className="btn-row">
          {/* No comes first and has the focus: it is the answer until the survivor changes it. */}
          <button type="button" className="btn btn-primary" autoFocus onClick={onNo}>
            {c.no}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onYes}>
            {c.yes}
          </button>
        </div>
      }
    >
      <dl className={styles.consentList}>
        <div>
          <dt>{c.whatTitle}</dt>
          <dd>{ask?.kind === "rows" ? c.whatRows(ask.rows) : c.whatBill}</dd>
        </div>
        <div>
          <dt>{c.whoTitle}</dt>
          <dd>{rows ? c.whoRows : c.whoBill}</dd>
        </div>
        <div>
          <dt>{c.stayTitle}</dt>
          <dd>{rows ? c.stayRows : c.stayBill}</dd>
        </div>
      </dl>
      <p className="meta">{c.noNote}</p>
    </FlowSheet>
  );
}
