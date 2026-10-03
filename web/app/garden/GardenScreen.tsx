"use client";

import Link from "next/link";
import FlowGate from "@/components/FlowGate";
import Money from "@/components/Money";
import Plant from "@/components/Plant";
import { formatDay, todayIso } from "@/lib/dates";
import { expenseLabel, expenseRank } from "@/lib/expenses";
import { MONEY_STAGES, moneyGrowth, moneyStage, type Stage } from "@/lib/garden";
import { formatCents } from "@/lib/money";
import { useSession, type Session } from "@/lib/session";
import type { EngineLine, ScanItem } from "@/lib/types";
import styles from "./garden.module.css";

interface Bloomable {
  line: EngineLine;
  item: ScanItem;
  stage: Stage;
}

const stageLabel = (s: Stage) => MONEY_STAGES.find((m) => m.stage === s)?.label ?? s;

function NextStep({ plant, session }: { plant: Bloomable; session: Session }) {
  const { updateLife } = useSession();
  const id = plant.item.item_id;
  const life = session.life[id] ?? {};

  if (plant.stage === "sprout") {
    return (
      <label className={`btn btn-quiet ${styles.action}`}>
        <input
          type="file"
          accept="image/*,application/pdf"
          className="visually-hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) updateLife([id], { receipt: file.name });
          }}
        />
        Attach a receipt
      </label>
    );
  }
  if (plant.stage === "leaf") {
    return (
      <p className={styles.hint}>
        {life.receipt ? (
          <span className={styles.receipt} title={life.receipt}>
            Receipt: {life.receipt}
          </span>
        ) : null}
        Buds when you <Link href="/claim">mark the claim as sent</Link>.
      </p>
    );
  }
  if (plant.stage === "bud") {
    return (
      <button
        type="button"
        className={`btn btn-quiet ${styles.action}`}
        onClick={() => updateLife([id], { paid_at: todayIso() })}
      >
        Mark as paid
      </button>
    );
  }
  return (
    <p className={styles.hint}>
      Paid {life.paid_at ? formatDay(life.paid_at, "short") : ""}.{" "}
      <button type="button" className="link-button" onClick={() => updateLife([id], { paid_at: undefined })}>
        Undo
      </button>
    </p>
  );
}

function GardenView({ session }: { session: Session }) {
  const { claim } = useSession();
  const output = claim.evaluation?.output;
  if (!output) return <p className="meta">Checking the law</p>;

  const items = new Map(session.scan.items.map((i) => [i.item_id, i]));
  const plants: Bloomable[] = output.lines
    .filter((l) => l.status === "eligible" && l.allowed_cents > 0 && items.has(l.item_id))
    .map((line) => ({
      line,
      item: items.get(line.item_id)!,
      stage: moneyStage(true, session.life[line.item_id])!,
    }));
  const beds = [...new Set(plants.map((p) => p.line.expense))].sort((a, b) => expenseRank(a) - expenseRank(b));
  const held = output.lines.filter((l) => l.status === "held");
  const paidCents = plants.filter((p) => p.stage === "bloom").reduce((s, p) => s + p.line.allowed_cents, 0);

  return (
    <div className={styles.garden}>
      <header className={styles.head}>
        <h1>Your garden</h1>
        <p className="lead">A plant grows here only for money that comes back to you.</p>
        <p className={styles.tally}>
          {plants.length} {plants.length === 1 ? "plant" : "plants"} for{" "}
          <Money cents={output.totals.allowed_cents} face="inherit" />.{" "}
          {paidCents > 0 ? (
            <>
              In bloom: <Money cents={paidCents} face="inherit" />.
            </>
          ) : (
            "Nothing paid yet."
          )}
        </p>
      </header>

      <ol className={styles.stages} aria-label="How a plant grows">
        {MONEY_STAGES.map((s) => (
          <li key={s.stage}>
            <span className={styles.stagePlant}>
              <Plant stage={s.stage} growth={0.55} seedKey={`stage-${s.stage}`} />
            </span>
            <span>
              <strong>{s.label}</strong>
              <span className={styles.when}>{s.when}</span>
            </span>
          </li>
        ))}
      </ol>

      {plants.length === 0 ? (
        <p className={styles.emptyNote}>
          Nothing has sprouted yet. When you say yes to a cost on the{" "}
          <Link replace href="/ledger">
            Costs
          </Link>{" "}
          page, a sprout appears here.
        </p>
      ) : null}

      <div className={styles.plots}>
        {beds.map((expense) => {
          const inBed = plants.filter((p) => p.line.expense === expense);
          return (
            <section key={expense} className={styles.bed} aria-labelledby={`g-${expense}`}>
              <h2 id={`g-${expense}`} className={styles.bedTitle}>
                {expenseLabel(expense)}
                <Money cents={inBed.reduce((s, p) => s + p.line.allowed_cents, 0)} className={styles.bedAmount} />
              </h2>
              <ul className={styles.plants}>
                {inBed.map((p) => (
                  <li key={p.item.item_id} className={styles.plant} data-stage={p.stage}>
                    <div className={styles.drawing}>
                      <Plant
                        stage={p.stage}
                        growth={moneyGrowth(p.line.allowed_cents)}
                        seedKey={p.item.item_id}
                        label={`${stageLabel(p.stage)} for ${formatCents(p.line.allowed_cents)}`}
                        ground={false}
                      />
                    </div>
                    <p className={styles.amount}>
                      <Money cents={p.line.allowed_cents} />
                    </p>
                    <p className={styles.what}>
                      {p.item.merchant ?? p.item.description}, {formatDay(p.item.date, "short")}
                    </p>
                    <p className={styles.stageName}>{stageLabel(p.stage)}</p>
                    <NextStep plant={p} session={session} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      {held.length ? (
        <aside className={styles.held} aria-label="Held bills">
          <svg viewBox="0 0 12 12" width="14" height="14" aria-hidden="true">
            <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="currentColor" />
          </svg>
          <p>
            <strong>Held: {formatCents(held.reduce((s, l) => s + l.requested_cents, 0))}</strong> on a bill the law says
            you should not pay. Nothing grows from it because it is not yours to pay.{" "}
            <Link replace href="/bill">
              See the bill
            </Link>
          </p>
        </aside>
      ) : null}
    </div>
  );
}

export default function GardenScreen() {
  return <FlowGate>{(session) => <GardenView session={session} />}</FlowGate>;
}
