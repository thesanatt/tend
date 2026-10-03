import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import AsmListing from "@/components/law/AsmListing";
import styles from "@/components/law/law.module.css";
import Plant from "@/components/Plant";
import RuleCard from "@/components/RuleCard";
import { CATEGORY_LABEL, CATEGORY_ORDER } from "@/lib/categories";
import { formatTimestamp } from "@/lib/dates";
import { LAW_STAGES, lawGrowth, lawStage } from "@/lib/garden";
import STATES from "@/lib/states.json";
import type { Jurisdiction } from "@/lib/types";

// Built from the verified corpus copy in public/data/law (scripts/sync-rules.mjs).
async function loadLaw(st: string): Promise<{ law: Jurisdiction; sha256: string } | null> {
  try {
    const raw = await readFile(path.join(process.cwd(), "public", "data", "law", `${st}.json`));
    return {
      law: JSON.parse(raw.toString("utf8")) as Jurisdiction,
      sha256: createHash("sha256").update(raw).digest("hex"),
    };
  } catch {
    return null;
  }
}

export const dynamicParams = false;

export function generateStaticParams() {
  return STATES.map((s) => ({ st: s.st }));
}

export async function generateMetadata({ params }: { params: Promise<{ st: string }> }): Promise<Metadata> {
  const { st } = await params;
  const name = STATES.find((s) => s.st === st)?.name ?? st;
  return { title: `${name} law` };
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default async function LawPage({ params }: { params: Promise<{ st: string }> }) {
  const { st } = await params;
  const loaded = await loadLaw(st);
  const name = STATES.find((s) => s.st === st)?.name ?? st;

  if (!loaded) {
    if (!STATES.some((s) => s.st === st)) notFound();
    return (
      <div className={`page ${styles.law}`}>
        <p className={styles.crumb}>
          <Link href="/">Law garden</Link> / {name}
        </p>
        <h1>{name}</h1>
        <p className="lead">Tend has not verified this program&apos;s rules yet, so nothing here is counted for it.</p>
      </div>
    );
  }

  const { law, sha256 } = loaded;
  const { program } = law;
  const sources = new Map(law.sources.map((s) => [s.id, s]));
  const groups = CATEGORY_ORDER.map((c) => ({ category: c, rules: law.rules.filter((r) => r.category === c) })).filter(
    (g) => g.rules.length,
  );
  const stage = LAW_STAGES.find((s) => s.stage === lawStage(law.rules.length))!;

  return (
    <div className={`page ${styles.law}`}>
      <p className={styles.crumb}>
        <Link href="/">Law garden</Link> / {law.name}
      </p>

      <header className={styles.head}>
        <div className={styles.headText}>
          <h1>{law.name}</h1>
          <p className="lead">
            {program.program_name}, run by {program.agency}.
          </p>
          {program.statute_citation ? <p className={styles.statute}>Statute: {program.statute_citation}</p> : null}
          <ul className={styles.contact}>
            {program.phone ? (
              <li>
                <a href={`tel:${program.phone.replace(/[^\d+]/g, "")}`}>{program.phone}</a>
              </li>
            ) : null}
            <li>
              <a href={program.website} target="_blank" rel="noopener noreferrer">
                {host(program.website)}
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
            </li>
            {program.apply_url ? (
              <li>
                <a href={program.apply_url} target="_blank" rel="noopener noreferrer">
                  How to apply
                  <span className="visually-hidden"> (opens in a new tab)</span>
                </a>
              </li>
            ) : null}
            {program.application_pdf_url ? (
              <li>
                <a href={program.application_pdf_url} target="_blank" rel="noopener noreferrer">
                  Application form (PDF)
                  <span className="visually-hidden"> (opens in a new tab)</span>
                </a>
              </li>
            ) : null}
          </ul>
        </div>
        <figure className={styles.plantFigure}>
          <Plant stage={stage.stage} growth={lawGrowth(law.rules.length)} seedKey={law.jurisdiction} />
          <figcaption>
            <strong>{stage.label}</strong>
            <span>
              {law.rules.length} rules verified from {law.sources.length} official sources. Research confidence:{" "}
              {law.confidence}.
            </span>
          </figcaption>
        </figure>
      </header>

      <p className={styles.method}>
        Every rule below is quoted word for word from a saved official source. Tend&apos;s checker keeps a rule only if
        its quote matches the saved text and every number in it appears in the quote.
      </p>

      {law.coverage?.not_found?.length || law.coverage?.notes ? (
        <details className={styles.gaps}>
          <summary>What Tend could not find or verify</summary>
          {law.coverage.not_found?.length ? (
            <ul>
              {law.coverage.not_found.map((n) => (
                <li key={n}>{n.replace(/_/g, " ")}</li>
              ))}
            </ul>
          ) : null}
          {law.coverage.notes ? <p>{law.coverage.notes}</p> : null}
        </details>
      ) : null}

      <nav aria-label="Rule groups" className={styles.toc}>
        <ul>
          {groups.map((g) => (
            <li key={g.category}>
              <a href={`#${g.category}`}>{CATEGORY_LABEL[g.category]}</a> <span className="meta">{g.rules.length}</span>
            </li>
          ))}
          <li>
            <a href="#compiled">Compiled law</a>
          </li>
          <li>
            <a href="#sources">Sources</a>
          </li>
        </ul>
      </nav>

      {groups.map((g) => (
        <section key={g.category} id={g.category} className={styles.group} aria-labelledby={`h-${g.category}`}>
          <h2 id={`h-${g.category}`}>{CATEGORY_LABEL[g.category]}</h2>
          <div className={styles.rules}>
            {g.rules.map((r) => (
              <RuleCard key={r.id} rule={r} source={sources.get(r.source_id)} />
            ))}
          </div>
        </section>
      ))}

      <section id="compiled" className={styles.group} aria-labelledby="h-compiled">
        <h2 id="h-compiled">Compiled law</h2>
        <p className={styles.method}>
          The engine compiles these rules into a law image and runs it as bytecode, the same way on the server and in
          the browser. Each block in the listing is commented with the rule it came from.
        </p>
        <p className="meta">
          Verified rules SHA-256 <code className={styles.sha}>{sha256}</code>
        </p>
        <AsmListing st={law.jurisdiction} />
      </section>

      <section id="sources" className={styles.group} aria-labelledby="h-sources">
        <h2 id="h-sources">Sources</h2>
        <div className={styles.tableWrap}>
          <table className={styles.sources}>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Kind</th>
                <th scope="col">Saved</th>
                <th scope="col">SHA-256</th>
              </tr>
            </thead>
            <tbody>
              {law.sources.map((s) => (
                <tr key={s.id}>
                  <th scope="row">
                    <a href={s.url} target="_blank" rel="noopener noreferrer">
                      {s.title}
                      <span className="visually-hidden"> (opens in a new tab)</span>
                    </a>
                    <span className={styles.sourceId}>{s.id}</span>
                  </th>
                  <td>{s.kind.replace(/_/g, " ")}</td>
                  <td>{formatTimestamp(s.retrieved_at)}</td>
                  <td>
                    <code title={s.sha256}>{s.sha256.slice(0, 12)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {law.researcher_notes ? (
          <details className={styles.gaps}>
            <summary>Researcher notes</summary>
            <p>{law.researcher_notes}</p>
          </details>
        ) : null}
      </section>
    </div>
  );
}
