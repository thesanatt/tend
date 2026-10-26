import type { Metadata } from "next";
import Link from "next/link";
import { buildCompareRow, COLUMNS, type ColumnId, type CompareLine } from "@/components/public/compare";
import { savedDays } from "@/components/public/corrections";
import { allStates, loadIr, loadLaw } from "@/components/public/data";
import Linkified from "@/components/public/Linkified";
import { sitePreview } from "@/components/public/og/siteCard";
import { Saved } from "@/components/public/SourceNote";
import styles from "./compare.module.css";

// Five facts from every program, side by side, each in the words of its state page (components/public/compare.ts).
// Built from public/data when the site is built, like the state pages; every rule id links to the rule on
// /law/ST, where its quote is. Static, no tracking.
export const metadata: Metadata = {
  title: "Compare the states",
  description:
    "The deadline to apply, the police report rule, the total cap, counseling limits, and the forensic exam bill for every state and DC, each linked to its rules.",
  ...sitePreview("compare"),
};

const COL_CLASS: Record<ColumnId, string> = {
  deadline: styles.colDeadline,
  report: styles.colReport,
  total: styles.colTotal,
  counseling: styles.colCounseling,
  exam: styles.colExam,
};

function load() {
  return allStates().flatMap((ref) => {
    const loaded = loadLaw(ref.st);
    if (!loaded) return [];
    const { law } = loaded;
    // Rule ids a line names in its text become links, as on the state page.
    const ids = new Set([...law.rules.map((r) => r.id), ...law.sources.map((s) => s.id)]);
    return [{ law, ids, row: buildCompareRow(law, loadIr(ref.st)) }];
  });
}

function Cites({ st, ids }: { st: string; ids: string[] }) {
  if (!ids.length) return null;
  return (
    <p className={styles.cites}>
      {ids.map((id) => (
        <a key={id} href={`/law/${st}#${id}`} className={styles.cite}>
          <span className="visually-hidden">Rule </span>
          {id}
        </a>
      ))}
    </p>
  );
}

function Line({ st, name, ids, line }: { st: string; name: string; ids: Set<string>; line: CompareLine }) {
  if (line.kind === "gap") return <p className={`${styles.line} ${styles.note}`}>{line.text}</p>;
  if (line.kind === "more") {
    return (
      <p className={styles.line}>
        <a href={line.href} className={styles.more}>
          {line.text}
          <span className="visually-hidden"> on the {name} page</span>
        </a>
      </p>
    );
  }
  if (line.kind === "key") {
    return (
      <div className={styles.line}>
        <p className={styles.answer}>{line.key.big}</p>
        <p className={styles.sub}>{line.key.small}</p>
        <Cites st={st} ids={line.key.cites} />
      </div>
    );
  }
  const { fact } = line;
  if (fact.kind === "note") return <p className={`${styles.line} ${styles.note}`}>{fact.text}</p>;
  // A line's details each cite their own rule; the line cites the rest, as the state page does.
  const details = fact.details ?? [];
  const own = fact.cites.filter((id) => !details.some((d) => d.cite === id));
  return (
    <div className={styles.line}>
      {fact.label ? (
        <p className={styles.answer}>
          {fact.label}
          {fact.text ? ` ${fact.text}` : null}
        </p>
      ) : (
        <p>
          <Linkified text={fact.text} st={st} ids={ids} />
        </p>
      )}
      <Cites st={st} ids={own} />
      {details.length ? (
        <ul className={styles.details}>
          {details.map((d) => (
            <li key={d.cite}>
              <Linkified text={d.text} st={st} ids={ids} />
              <Cites st={st} ids={[d.cite]} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default function ComparePage() {
  const loaded = load();
  const saved = savedDays(loaded.flatMap(({ law }) => law.sources));

  return (
    <div className={`page ${styles.compare}`}>
      <header className={styles.head}>
        <p className={styles.crumb}>
          <Link href="/">Law garden</Link> / Compare
        </p>
        <h1>Compare the states</h1>
        <p className="lead">
          Every state and DC runs a crime victim compensation program. This table puts five facts about each one side by
          side, in the same words as its page on Tend.
        </p>
        <div className={styles.notes}>
          <p>
            Each fact links to the rules behind it. A code like MI-FILE-1 opens that rule with the exact sentence from
            the source Tend saved.
          </p>
          <p>
            Where a state&apos;s page has no short answer for a fact, the cell shows the lines that page gives for it. A
            line that starts with &quot;Note:&quot; is Tend&apos;s own, as it is on the state&apos;s page.
          </p>
          <p>
            When a cell says Tend has not verified something, that is a gap in Tend&apos;s research. It does not mean
            the state has no such rule.
          </p>
          {saved ? (
            <p>
              Tend saved copies of this page&apos;s sources <Saved {...saved} /> and checked every quote against those
              copies word for word. Laws change, so ask the program before you rely on a date or amount.
            </p>
          ) : null}
        </div>
        <p className={styles.decides}>Tend is not legal advice. The program decides every claim.</p>
      </header>

      <details className={styles.jump}>
        <summary>Go to a state</summary>
        <ul>
          {loaded.map(({ row }) => (
            <li key={row.st}>
              <a href={`#${row.st.toLowerCase()}`}>
                {row.st}
                <span className="visually-hidden"> {row.name}</span>
              </a>
            </li>
          ))}
        </ul>
      </details>

      <p className={styles.hint}>The table scrolls sideways. The state name stays in view.</p>
      {/* On a phone each row is shown as a card. The explicit roles keep the table a table for screen
          readers when CSS changes how its parts display. */}
      <div className={styles.scroller} role="region" aria-labelledby="compare-caption" tabIndex={0}>
        <table className={styles.table} role="table">
          <caption id="compare-caption" className={styles.caption}>
            Five facts for each program, as its state page gives them
          </caption>
          <colgroup>
            <col className={styles.colState} />
            {COLUMNS.map((c) => (
              <col key={c.id} className={COL_CLASS[c.id]} />
            ))}
          </colgroup>
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader">
                State
              </th>
              {COLUMNS.map((c) => (
                <th key={c.id} scope="col" role="columnheader">
                  {c.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {loaded.map(({ row, ids }) => (
              <tr key={row.st} id={row.st.toLowerCase()} role="row">
                <th scope="row" role="rowheader">
                  {/* No prefetch: scrolling past 51 states should not fetch 51 pages. */}
                  <Link href={`/${row.st.toLowerCase()}`} prefetch={false}>
                    {row.name}
                  </Link>
                </th>
                {row.cells.map((cell, i) => (
                  <td key={cell.id} role="cell">
                    {/* The card's label; the column header already names the cell for screen readers. */}
                    <span className={styles.label} aria-hidden="true">
                      {COLUMNS[i].title}
                    </span>
                    <div className={styles.body}>
                      {cell.lines.map((line, j) => (
                        <Line key={j} st={row.st} name={row.name} ids={ids} line={line} />
                      ))}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
