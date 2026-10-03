"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import Plant from "@/components/Plant";
import { LAW_STAGES, lawGrowth, lawStage } from "@/lib/garden";
import STATES from "@/lib/states.json";
import type { JurisdictionSummary } from "@/lib/types";
import styles from "./LawGarden.module.css";

const stageLabel = (rules: number) => LAW_STAGES.find((s) => s.stage === lawStage(rules))!.label;

// The national law garden. Each tile opens that state's page; hovering or focusing a tile shows its
// numbers beside the map. Everything here was counted when the site was built.
export default function LawGarden({ jurisdictions }: { jurisdictions: JurisdictionSummary[] }) {
  const [selected, setSelected] = useState("MI");
  const [view, setView] = useState<"map" | "list">("map");
  const byState = useMemo(() => new Map(jurisdictions.map((d) => [d.st, d])), [jurisdictions]);
  const current = byState.get(selected);

  return (
    <section className={styles.garden} aria-labelledby="garden-title">
      <div className={styles.head}>
        <div className={styles.headText}>
          <h2 id="garden-title">The law garden</h2>
          <p>
            One plant for each program. A plant grows as Tend verifies more of that state&apos;s rules, and a rule counts
            only when its quote matches the saved law word for word. Pick a state to see what it promises.
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
          <ul className={styles.map} aria-label="States and DC">
            {STATES.map(({ st, name, row, col }) => {
              const rules = byState.get(st)?.rules ?? 0;
              return (
                <li key={st} style={{ gridRow: row + 1, gridColumn: col + 1 }}>
                  <Link
                    href={`/${st.toLowerCase()}`}
                    className={styles.tile}
                    data-selected={selected === st ? "" : undefined}
                    onMouseEnter={() => setSelected(st)}
                    onFocus={() => setSelected(st)}
                  >
                    <Plant stage={lawStage(rules)} growth={lawGrowth(rules)} seedKey={st} className={styles.tilePlant} />
                    {/* The visible abbreviation stays in the accessible name, so voice control can say "MI". */}
                    <span className={styles.abbr}>{st}</span>{" "}
                    {/* The space sits outside the hidden span, so the name reads "MI Michigan", not "MIMichigan". */}
                    <span className="visually-hidden">
                      {name}, {rules} rules verified, {stageLabel(rules).toLowerCase()}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>

          <aside className={styles.detail} aria-label="Selected state">
            {current ? (
              <>
                <div className={styles.detailPlant} aria-hidden="true">
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
                  {current.rules > 0 ? (
                    <div className={styles.detailLinks}>
                      <Link href={`/${current.st.toLowerCase()}`} className="btn btn-primary">
                        What {current.st === "DC" ? "DC" : current.name} promises
                      </Link>
                      <Link href={`/law/${current.st}`}>How Tend decides</Link>
                    </div>
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
                <th scope="col">How Tend decides</th>
              </tr>
            </thead>
            <tbody>
              {[...jurisdictions]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((s) => (
                  <tr key={s.st}>
                    <th scope="row">
                      {s.rules > 0 ? <Link href={`/${s.st.toLowerCase()}`}>{s.name}</Link> : s.name}
                    </th>
                    <td>{s.program ?? "Not verified yet"}</td>
                    <td className={styles.num}>{s.rules}</td>
                    <td className={styles.num}>{s.sources}</td>
                    <td>
                      {s.rules > 0 ? (
                        <Link href={`/law/${s.st}`}>
                          Rules<span className="visually-hidden"> for {s.name}</span>
                        </Link>
                      ) : (
                        "None yet"
                      )}
                    </td>
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
