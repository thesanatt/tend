"use client";

import Link from "next/link";
import BankActivity from "@/components/bank/BankActivity";
import PayoutDemo, { DemoPaidNote, isDemoPaid } from "@/components/bank/PayoutDemo";
import Money from "@/components/Money";
import Plant from "@/components/Plant";
import { addDays, localDay } from "@/lib/dates";
import { moneyGrowth } from "@/lib/garden";
import { useI18n, type Dict } from "@/lib/i18n";
import { useLaw } from "@/lib/useLaw";
import { buildCheckSummary } from "../checkSummary";
import { useSetAside } from "../useSetAside";
import { GROUPS, groupOf, knowsDate, paidLines, plants, type PlantView, type Stage } from "../claim";
import { useFlow } from "../FlowProvider";
import styles from "../flow.module.css";

const STAGES: Stage[] = ["sprout", "leaf", "bud", "bloom"];

// A plain calendar file the survivor saves on purpose. Nothing in it, not even the app's name,
// says what it is about.
export function reminderIcs(date: string, text: string, stamp: string): string {
  const d = date.replace(/-/g, "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Reminder//EN",
    "BEGIN:VEVENT",
    `UID:${stamp}@local`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${d}`,
    `SUMMARY:${text}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

// A check-in a month out, or a week before the deadline when that comes sooner.
export function reminderDate(today: string, deadline: string | null): string {
  const month = addDays(today, 30);
  if (!deadline) return month;
  const before = addDays(deadline, -7);
  const pick = before < month ? before : month;
  return pick > today ? pick : addDays(today, 1);
}

function NextStep({ plant, t }: { plant: PlantView; t: Dict }) {
  const { f } = useI18n();
  const { state, dispatch, today } = useFlow();
  const id = plant.item.item_id;
  const life = state.life[id] ?? {};
  const fileId = `doc-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  if (plant.stage === "sprout") {
    return (
      <label htmlFor={fileId} className={`btn btn-quiet ${styles.plantAction}`}>
        <input
          id={fileId}
          type="file"
          accept="image/*,application/pdf"
          className="visually-hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) dispatch({ type: "life", ids: [id], patch: { doc: file.name } });
          }}
        />
        {t.track.attach}
        <span className="visually-hidden">: {plant.item.description}</span>
      </label>
    );
  }
  if (plant.stage === "leaf") {
    const paid = paidLines(state).get(id);
    return (
      <p className={styles.plantHint}>
        {life.doc ? <span className={styles.docName}>{t.track.attached(life.doc)}</span> : null}
        {plant.item.origin === "bill" && !life.doc ? <span className={styles.billDoc}>{t.track.billIsDoc}</span> : null}
        {paid ? <span className={styles.billDoc}>{t.track.youPaid(f.date(localDay(paid.at), "short"))}</span> : null}
        {t.track.budsWhen}
      </p>
    );
  }
  if (plant.stage === "bud") {
    return (
      <button
        type="button"
        className={`btn btn-quiet ${styles.plantAction}`}
        onClick={() => dispatch({ type: "life", ids: [id], patch: { paid_at: today } })}
      >
        {t.track.markPaid}
        <span className="visually-hidden">: {plant.item.description}</span>
      </button>
    );
  }
  // A bloom from the demo of the program paying says so; its undo is on the demo itself.
  if (isDemoPaid(state, id)) return <DemoPaidNote className={styles.plantHint} />;
  return (
    <p className={styles.plantHint}>
      {t.track.paidOn(life.paid_at ? f.date(life.paid_at, "short") : "")}{" "}
      <button
        type="button"
        className="link-button"
        onClick={() => dispatch({ type: "life", ids: [id], patch: { paid_at: undefined } })}
      >
        {t.common.undo}
        <span className="visually-hidden">: {plant.item.description}</span>
      </button>
    </p>
  );
}

export default function TrackScreen() {
  const { t, f } = useI18n();
  const { state, claim, today } = useFlow();
  const law = useLaw(state.check.st || null);
  const setAside = useSetAside(state.check.st || null);
  const output = claim.evaluation?.output.jurisdiction === state.check.st ? claim.evaluation.output : null;
  const all = plants(state, output).map((p) =>
    p.stage === "sprout" && p.item.origin === "bill" ? { ...p, stage: "leaf" as const } : p,
  );
  const summary =
    law.law && output ? buildCheckSummary(law.law, output, state.check, knowsDate(state, today), setAside) : null;
  const deadline = summary?.deadline.kind === "date" ? summary.deadline : null;
  const held = output?.lines.filter((l) => l.status === "held") ?? [];
  const paidCents = all.filter((p) => p.stage === "bloom").reduce((s, p) => s + p.line.allowed_cents, 0);

  if (!state.check.st) {
    return (
      <section className={styles.needState}>
        <h1>{t.track.title}</h1>
        <p className="lead">{t.gather.needState}</p>
        <Link replace href="/check" className="btn btn-primary">
          {t.gather.toCheck}
        </Link>
      </section>
    );
  }

  return (
    <div className={styles.track}>
      <header className={styles.screenHead}>
        <h1>{t.track.title}</h1>
        <p className="lead">{t.track.lead}</p>
      </header>

      {/* A late deadline counted from the report or from discovery may not be late (docs/SPEC.md v1.3):
          it is explained, never shown as plainly late. */}
      <p
        className={styles.deadlineBar}
        data-late={(deadline?.late && !deadline.fromReport && !deadline.fromDiscovery) || undefined}
      >
        <strong>
          {deadline
            ? deadline.late
              ? t.check.deadlineLate(f.date(deadline.date))
              : t.check.deadlineDate(f.date(deadline.date))
            : summary
              ? t.track.deadlineAsk
              : // The law and the claim are still loading; "ask the program" would be wrong for a moment.
                t.engine.computing}
        </strong>
        {deadline && !deadline.late ? <span> {t.check.deadlineLeft(f.span(today, deadline.date) ?? "")}</span> : null}
        {deadline?.fromReport ? <span className={styles.deadlineNote}>{t.check.deadlineFromReport}</span> : null}
        {deadline?.fromDiscovery ? <span className={styles.deadlineNote}>{t.check.deadlineFromDiscovery}</span> : null}
      </p>

      <p className={styles.tallyLine}>
        {t.track.tally(all.length, f.money(output?.totals.allowed_cents ?? 0))}{" "}
        {paidCents > 0 ? t.track.paidSoFar(f.money(paidCents)) : t.track.nothingPaid}
      </p>

      <ol className={styles.legend} aria-label={t.track.legendLabel}>
        {STAGES.map((s) => (
          <li key={s}>
            <span className={styles.legendPlant}>
              <Plant stage={s} growth={0.55} seedKey={`stage-${s}`} />
            </span>
            <span>
              <strong>{t.track.stage[s]}</strong>
              <span className={styles.when}>{t.track.when[s]}</span>
            </span>
          </li>
        ))}
      </ol>

      {all.length === 0 ? (
        <p className={styles.emptyNote}>
          {t.track.empty} <Link href="/gather">{t.track.toGather}</Link>
        </p>
      ) : null}

      <div className={styles.plots}>
        {GROUPS.map((g) => {
          const inBed = all.filter((p) => groupOf(p.line.expense) === g);
          if (!inBed.length) return null;
          return (
            <section key={g} className={styles.plot} aria-labelledby={`plot-${g}`}>
              <h2 id={`plot-${g}`} className={styles.plotTitle}>
                {t.group[g]}
                <Money cents={inBed.reduce((s, p) => s + p.line.allowed_cents, 0)} className={styles.plotAmount} />
              </h2>
              <ul className={styles.plantList}>
                {inBed.map((p) => (
                  <li key={p.item.item_id} className={styles.plant} data-stage={p.stage}>
                    <div className={styles.drawing}>
                      <Plant
                        stage={p.stage}
                        growth={moneyGrowth(p.line.allowed_cents)}
                        seedKey={p.item.item_id}
                        label={t.track.plantLabel(
                          t.track.stage[p.stage],
                          p.item.description,
                          f.money(p.line.allowed_cents),
                        )}
                        ground={false}
                      />
                    </div>
                    <p className={styles.plantAmount}>
                      <Money cents={p.line.allowed_cents} />
                    </p>
                    <p className={styles.plantWhat}>
                      {p.item.merchant ?? p.item.description}
                      {p.item.origin !== "bill" ? `, ${f.date(p.item.date, "short")}` : ""}
                    </p>
                    <p className={styles.stageName}>{t.track.stage[p.stage]}</p>
                    <NextStep plant={p} t={t} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      <PayoutDemo />

      {held.length ? (
        <aside className={styles.heldAside} aria-label={t.track.heldLabel}>
          <svg viewBox="0 0 12 12" width="14" height="14" aria-hidden="true">
            <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="currentColor" />
          </svg>
          <p>
            {t.track.held(f.money(held.reduce((s, l) => s + l.requested_cents, 0)))}{" "}
            <Link href="/gather/bills">{t.gather.seeBill}</Link>
          </p>
        </aside>
      ) : null}

      <section className={styles.remind} aria-labelledby="remind-title">
        <h2 id="remind-title">{t.track.remindTitle}</h2>
        <p>{t.track.remindBody(t.track.remindText)}</p>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => {
            const when = reminderDate(today, deadline && !deadline.late ? deadline.date : null);
            const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
            const ics = reminderIcs(when, t.track.remindText, stamp);
            const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = "reminder.ics";
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          {t.track.remindButton}
        </button>
      </section>

      <BankActivity />
    </div>
  );
}
