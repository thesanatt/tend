"use client";

import type { StatementTxn } from "@/lib/contracts";
import { useI18n } from "@/lib/i18n";
import styles from "./preview.module.css";

export const SHOW_ROWS = 25;

// "Larkfield Market - groceries" from a bank row that keeps the merchant apart; a statement row
// already carries it in its description.
function describe(t: StatementTxn): string {
  if (!t.merchant || t.description.toLowerCase().includes(t.merchant.toLowerCase())) return t.description;
  return `${t.merchant} - ${t.description}`;
}

// A statement as Tend read it: the first rows, money out as negative and money in with a plus, the way
// a bank writes them (the contract keeps money out positive).
export default function TablePreview({ name, rows }: { name: string; rows: StatementTxn[] }) {
  const { t, f } = useI18n();
  if (!rows.length) return <p className={styles.note}>{t.preview.noRows}</p>;
  const shown = rows.slice(0, SHOW_ROWS);
  return (
    <div className={styles.table}>
      <p className={styles.rowCount}>{t.preview.rowCount(name, rows.length)}</p>
      {/* Its own scroll on a phone, so the page never scrolls sideways; focusable for the keyboard. */}
      <div className={styles.tableScroll} role="region" aria-label={t.preview.tableLabel} tabIndex={0}>
        <table className={styles.rows}>
          <caption className="visually-hidden">{t.preview.caption(name)}</caption>
          <thead>
            <tr>
              <th scope="col">{t.preview.dateCol}</th>
              <th scope="col">{t.preview.descriptionCol}</th>
              <th scope="col" className={styles.num}>
                {t.preview.amountCol}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr key={`${row.id}-${i}`}>
                <td className={styles.date}>{f.date(row.date, "numeric")}</td>
                <td>{describe(row)}</td>
                <td className={styles.num}>
                  {row.amount_cents > 0 ? f.money(-row.amount_cents) : `+${f.money(-row.amount_cents)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="meta">{t.preview.showing(shown.length, rows.length)}</p>
    </div>
  );
}
