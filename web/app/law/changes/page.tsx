import type { Metadata } from "next";
import Link from "next/link";
import lawStyles from "@/components/public/law.module.css";
import STATES from "@/lib/states.json";
import { loadChanges } from "./data";
import { AllStates, StateChanges, VersionList, count, stateName, when } from "./parts";
import styles from "./changes.module.css";

// What changed in the law Tend uses, between any two published versions. Each version is its own Neon branch;
// the comparison reads both (docs/NEON.md). Public, no tracking, and nothing here is about a person.
export const metadata: Metadata = {
  title: "Law changes",
  description: "What changed in each program's verified rules between two versions, with the exact quotes and sources.",
};

type Params = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

export default async function LawChanges({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const raw = one(params.st)?.toUpperCase();
  const st = raw && STATES.some((s) => s.st === raw) ? raw : undefined;
  const view = await loadChanges({ st, from: one(params.from), to: one(params.to) });
  const name = st ? stateName(st) : null;
  const states = [...STATES].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className={`page ${styles.changes}`}>
      <header className={styles.head}>
        <p className={lawStyles.crumb}>
          <Link href="/">Law garden</Link> /{" "}
          {st ? (
            <>
              <Link href={`/${st.toLowerCase()}`}>{name}</Link> / <Link href={`/law/${st}`}>How Tend decides</Link>{" "}
              /{" "}
            </>
          ) : null}
          Law changes
        </p>
        <h1>{name ? `What changed in ${name}'s rules` : "What changed in the rules Tend uses"}</h1>
        <p className="lead">
          Tend keeps every version of the verified rules. A version is a saved copy of all {view.to.jurisdictions}{" "}
          programs&apos; rules at one moment, kept as its own database branch, so it cannot change once it is published.
          Compare two versions to see what changed, with the exact quotes.
        </p>
      </header>

      <form method="get" action="/law/changes" className={styles.picker} aria-label="Pick what to compare">
        <label>
          <span>Program</span>
          <select name="st" defaultValue={st ?? ""}>
            <option value="">All programs</option>
            {states.map((s) => (
              <option key={s.st} value={s.st}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>From</span>
          <select name="from" defaultValue={view.from.name}>
            {view.versions.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>To</span>
          <select name="to" defaultValue={view.to.name}>
            {view.versions.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name}
                {v.name === view.current ? " (in use now)" : ""}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-primary">
          Compare
        </button>
      </form>

      <p className={styles.where}>
        {view.source === "live"
          ? `Compared from the two versions' database branches${view.comparedAt ? ` at ${when(view.comparedAt)}` : ""}: ${view.from.name} (${when(view.from.committed_at)}) and ${view.to.name} (${when(view.to.committed_at)}).`
          : `This is the comparison saved on ${when(view.savedAt ?? "")}, read from the same branches. The live service did not answer just now.`}
      </p>

      {view.unavailable ? (
        <section className={styles.result} aria-labelledby="h-result">
          <h2 id="h-result">This comparison needs the live service</h2>
          <p className={styles.none}>
            The saved copy holds each version against the one before it, and the first against the newest. Try one of
            those from the list below.
          </p>
        </section>
      ) : view.state ? (
        <StateChanges d={view.state} />
      ) : view.summary ? (
        <AllStates d={view.summary} />
      ) : null}

      <section className={styles.group} aria-labelledby="h-versions">
        <h2 id="h-versions">Every version</h2>
        <p className={lawStyles.groupNote}>
          Newest first. {count(view.versions.length, "version", "versions")} so far. The one marked in use now is the
          one Tend&apos;s server checks claims against.
        </p>
        <VersionList versions={view.versions} current={view.current} notes={view.notes} st={st} />
      </section>

      <section className={lawStyles.steps} aria-labelledby="h-how">
        <h2 id="h-how">How versions work</h2>
        <ol>
          <li>
            When the verified rules change, Tend publishes a new version as a branch of its database, named for the day
            and the change, like <code>{view.to.name}</code>.
          </li>
          <li>
            A new version starts as an exact copy of the one before it. Only the programs whose files changed are
            written again, so each version stores just what is new.
          </li>
          <li>
            This page reads both versions and lines up every rule by its id: added, removed, or changed, with the quote
            from each side.
          </li>
          <li>
            A claim packet names the version it was checked against, so anyone can come back here and see what has
            changed since.
          </li>
        </ol>
      </section>
    </div>
  );
}
