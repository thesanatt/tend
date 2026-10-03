import Money from "@/components/Money";
import { expenseLabel } from "@/lib/expenses";
import type { Bed as BedData } from "@/lib/ledger";
import type { Answer } from "@/lib/ledger";
import type { LawIndex } from "@/lib/useLaw";
import LedgerRow from "./LedgerRow";
import styles from "./ledger.module.css";

interface BedProps {
  bed: BedData;
  law: LawIndex;
  onAnswer: (itemId: string, value: Answer | null) => void;
  readOnly?: boolean;
}

export default function Bed({ bed, law, onAnswer, readOnly }: BedProps) {
  const id = `bed-${bed.expense}`;
  return (
    <section className={styles.bed} aria-labelledby={id}>
      <header className={styles.bedHead}>
        <h2 id={id}>{expenseLabel(bed.expense)}</h2>
        <p className={styles.bedTotal}>
          {bed.allowedCents > 0 ? (
            <>
              <Money cents={bed.allowedCents} className={styles.counted} /> <span>counted</span>
            </>
          ) : bed.heldCents > 0 ? (
            <>
              <Money cents={bed.heldCents} className={styles.heldAmount} /> <span>held</span>
            </>
          ) : (
            <span>
              {bed.rows.some((r) => r.status === "needs_confirmation") ? "Nothing counted yet" : "Not counted"}
            </span>
          )}
        </p>
      </header>
      <ol className={styles.rows}>
        {bed.rows.map((row) => (
          <LedgerRow key={row.item.item_id} row={row} law={law} onAnswer={onAnswer} readOnly={readOnly} />
        ))}
      </ol>
    </section>
  );
}
