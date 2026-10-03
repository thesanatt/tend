"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { fetchJurisdictions } from "@/lib/api";
import { formatTimestamp } from "@/lib/dates";
import { LAW_STAGES, lawGrowth, lawStage } from "@/lib/garden";
import STATES from "@/lib/states.json";
import type { JurisdictionSummary } from "@/lib/types";
import Plant from "./Plant";
import styles from "./NationalGarden.module.css";

const stageLabel = (rules: number) => LAW_STAGES.find((s) => s.stage === lawStage(rules))!.label;

function merge(base: JurisdictionSummary[], next: JurisdictionSummary[]): JurisdictionSummary[] {
  const fresh = new Map(next.map((n) => [n.st, n]));
  return base.map((b) => {
    const n = fresh.get(b.st);
    return n ? { ...b, ...Object.fromEntries(Object.entries(n).filter(([, v]) => v !== null && v !== undefined)) } : b;
  });
}

export default function NationalGarden({ initial }: { initial: JurisdictionSummary[] }) {
  const [data, setData] = useState(initial);
  const [selected, setSelected] = useState("MI");
  const [view, setView] = useState<"map" | "list">("map");

  // The garden grows while research runs: refetch when the tab comes back into view.
  useEffect(() => {
    const refresh = () =>
      fetchJurisdictions()
        .then((next) => {
          if (next.length) setData((d) => merge(d, next));
        })
        .catch(() => {});
    refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const byState = useMemo(() => new Map(data.map((d) => [d.st, d])), [data]);
  const totals = useMemo(
    () => ({
      read: data.filter((d) => d.rules > 0).length,
      rules: data.reduce((s, d) => s + d.rules, 0),
      sources: data.reduce((s, d) => s + d.sources, 0),
    }),
    [data],
  );
  const current = byState.get(selected);

  return (
    <section className={styles.garden} aria-labelledby="garden-title">
      <div className={styles.head}>
        <div className={styles.headText}>
          <h2 id="garden-title">The law garden</h2>
          <p>
            Each plant is one state&apos;s program. It grows as Tend verifies more of its rules, and a rule counts only
            when its quote matches the saved statute or agency page word for word. So far:{" "}
            {totals.rules.toLocaleString("en-US")} rules from {totals.sources.toLocaleString("en-US")} official sources,
            across {totals.read} of {data.length} programs.
          </p>
        </div>
        <div className={styles.toggle} role="group" aria-label="Show the garden as">
          <button type="button" aria-pressed={view === "map"} onClick={() => setView("map")}>
            Map
          </button>
          <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>
            List
          </button>
        </div>
      </div>

      {view === "map" ? (
        <div className={styles.layout}>
          <div className={styles.map} role="group" aria-label="States and DC">
            {STATES.map(({ st, name, row, col }) => {
              const s = byState.get(st);
              const rules = s?.rules ?? 0;
              return (
                <button
                  key={st}
                  type="button"
                  className={styles.tile}
                  style={{ gridRow: row + 1, gridColumn: col + 1 }}
                  aria-pressed={selected === st}
                  aria-label={`${name}: ${rules} rules verified, ${stageLabel(rules).toLowerCase()}`}
                  onMouseEnter={() => setSelected(st)}
                  onFocus={() => setSelected(st)}
                  onClick={() => setSelected(st)}
                >
                  <Plant stage={lawStage(rules)} growth={lawGrowth(rules)} seedKey={st} className={styles.tilePlant} />
                  <span className={styles.abbr}>{st}</span>
                </button>
              );
            })}
          </div>

          <aside className={styles.detail} aria-live="polite">
            {current ? (
              <>
                <div className={styles.detailPlant}>
                  <Plant stage={lawStage(current.rules)} growth={lawGrowth(current.rules)} seedKey={current.st} />
                </div>
                <div className={styles.detailText}>
                  <h3>{current.name}</h3>
                  <p className={styles.program}>{current.program ?? "Program name not verified yet"}</p>
                  <dl className={styles.facts}>
                    <div>
                      <dt>Rules verified</dt>
                      <dd>{current.rules}</dd>
                    </div>
                    <div>
                      <dt>Official sources</dt>
                      <dd>{current.sources}</dd>
                    </div>
                    <div>
                      <dt>Stage</dt>
                      <dd>{stageLabel(current.rules)}</dd>
                    </div>
                    {current.confidence ? (
                      <div>
                        <dt>Research confidence</dt>
                        <dd>{current.confidence.charAt(0).toUpperCase() + current.confidence.slice(1)}</dd>
                      </div>
                    ) : null}
                  </dl>
                  {current.verified_at ? (
                    <p className="meta">Newest source saved {formatTimestamp(current.verified_at)}</p>
                  ) : null}
                  {current.rules > 0 ? (
                    <Link href={`/law/${current.st}`} className="btn btn-secondary">
                      Read {current.name}&apos;s rules
                    </Link>
                  ) : null}
                </div>
              </>
            ) : null}
          </aside>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="visually-hidden">Verified rules by state</caption>
            <thead>
              <tr>
                <th scope="col">State</th>
                <th scope="col">Program</th>
                <th scope="col" className={styles.num}>
                  Rules
                </th>
                <th scope="col" className={styles.num}>
                  Sources
                </th>
                <th scope="col">Stage</th>
              </tr>
            </thead>
            <tbody>
              {[...data]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((s) => (
                  <tr key={s.st}>
                    <th scope="row">{s.rules > 0 ? <Link href={`/law/${s.st}`}>{s.name}</Link> : s.name}</th>
                    <td>{s.program ?? "Not verified yet"}</td>
                    <td className={styles.num}>{s.rules}</td>
                    <td className={styles.num}>{s.sources}</td>
                    <td>{stageLabel(s.rules)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      <ul className={styles.legend} aria-label="How a plant grows">
        {LAW_STAGES.map((s) => (
          <li key={s.stage}>
            <span className={styles.legendPlant}>
              <Plant stage={s.stage} growth={0.6} seedKey={`legend-${s.stage}`} />
            </span>
            <span>
              <strong>{s.label}</strong>
              <span className="meta">{s.range}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
