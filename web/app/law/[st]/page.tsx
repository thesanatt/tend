import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import AsmListing from "@/components/law/AsmListing";
import Plant from "@/components/Plant";
import { loadAsm, loadIr, loadLaw, stateFromParam } from "@/components/public/data";
import { count } from "@/components/public/format";
import { AsmView, groupRules, lawCategoryLabel, RuleEntry, SetAsideList, SourceList } from "@/components/public/LawParts";
import styles from "@/components/public/law.module.css";
import { LAW_STAGES, lawGrowth, lawStage } from "@/lib/garden";
import STATES from "@/lib/states.json";
import type { Rule } from "@/lib/types";

// "How Tend decides": every verified rule with its quote, what the compiler did with it, the
// compiled listing, and the saved sources. Built at build time from public/data.
export const dynamicParams = false;

export function generateStaticParams() {
  return STATES.map((s) => ({ st: s.st }));
}

export async function generateMetadata({ params }: { params: Promise<{ st: string }> }): Promise<Metadata> {
  const { st } = await params;
  const ref = stateFromParam(st);
  return { title: ref ? `${ref.name} law` : "Law" };
}

export default async function LawPage({ params }: { params: Promise<{ st: string }> }) {
  const { st } = await params;
  const ref = stateFromParam(st);
  if (!ref || ref.st !== st) notFound();
  const loaded = loadLaw(ref.st);

  if (!loaded) {
    return (
      <div className={`page ${styles.law}`}>
        <p className={styles.crumb}>
          <Link href="/">Law garden</Link> / {ref.name}
        </p>
        <h1>{ref.name}</h1>
        <p className="lead">Tend has not verified this program&apos;s rules yet, so nothing here is counted for it.</p>
      </div>
    );
  }

  const { law, sha256 } = loaded;
  const ir = loadIr(ref.st);
  const asm = loadAsm(ref.st);
  const sources = new Map(law.sources.map((s) => [s.id, s]));
  const rulesById = new Map<string, Rule>(law.rules.map((r) => [r.id, r]));
  const irById = new Map((ir?.rules ?? []).map((r) => [r.id, r]));
  const skipById = new Map((ir?.skipped ?? []).map((s) => [s.id, s]));
  const ruleIds = new Set(rulesById.keys());
  const groups = groupRules(law.rules);
  const stage = LAW_STAGES.find((s) => s.stage === lawStage(law.rules.length))!;
  const decision = (ir?.rules ?? []).filter((r) => r.kind !== "info").length;
  const info = (ir?.rules ?? []).filter((r) => r.kind === "info").length;
  const lower = ref.st.toLowerCase();

  return (
    <div className={`page ${styles.law}`}>
      <header className={styles.head}>
        <div className={styles.headText}>
          <p className={styles.crumb}>
            <Link href="/">Law garden</Link> / <Link href={`/${lower}`}>{law.name}</Link> / How Tend decides
          </p>
          <h1>How Tend decides in {law.name}</h1>
          <p className="lead">
            The verified rules for {law.program.program_name}, run by {law.program.agency}. Each rule shows its exact
            quote, where it was saved from, and what the law engine does with it.
          </p>
          {law.program.statute_citation ? (
            <p className="meta">Statute: {law.program.statute_citation}</p>
          ) : null}
          <ul className={styles.links} aria-label="Related pages and data">
            <li>
              <Link href={`/${lower}`}>What {law.name} promises, in plain words</Link>
            </li>
            <li>
              <a href={`/data/law/${ref.st}.json`}>Verified rules (JSON)</a>
            </li>
            {ir ? (
              <li>
                <a href={`/data/ir/${ref.st}.json`}>Law IR (JSON)</a>
              </li>
            ) : null}
            {asm ? (
              <li>
                <a href={`/data/asm/${ref.st}.txt`}>Compiled listing (text)</a>
              </li>
            ) : null}
          </ul>
        </div>
        <figure className={styles.plantFigure}>
          <Plant stage={stage.stage} growth={lawGrowth(law.rules.length)} seedKey={law.jurisdiction} />
          <figcaption>
            <strong>{stage.label}</strong>
            <span>
              {count(law.rules.length, "rule", "rules")} verified from {count(law.sources.length, "source", "sources")}.
              Research confidence: {law.confidence}.
            </span>
          </figcaption>
        </figure>
      </header>

      <dl className={styles.counts}>
        <div>
          <dt>Rules verified</dt>
          <dd>{law.rules.length}</dd>
        </div>
        <div>
          <dt>Official sources</dt>
          <dd>{law.sources.length}</dd>
        </div>
        {ir ? (
          <>
            <div>
              <dt>Used in decisions</dt>
              <dd>{decision}</dd>
            </div>
            <div>
              <dt>Shown for information</dt>
              <dd>{info}</dd>
            </div>
            <div>
              <dt>Set aside, with a reason</dt>
              <dd>{ir.skipped.length}</dd>
            </div>
          </>
        ) : null}
      </dl>

      <section className={styles.steps} aria-labelledby="h-check">
        <h2 id="h-check">How to check this page</h2>
        <ol>
          <li>
            Every rule quotes a saved copy of an official page, word for word. The SHA-256 under each source is the
            fingerprint of that saved copy, so anyone can confirm the text has not changed.
          </li>
          <li>
            A checker keeps a rule only if its quote matches the saved text and every number in the rule appears in the
            quote.
          </li>
          <li>
            A normalizer turns the rules into the law IR. Rules about someone other than the survivor, or with nothing to
            compute, are set aside with a reason.
          </li>
          <li>
            The compiler turns the IR into bytecode. The listing below is that bytecode, with each block commented with
            the rule it came from. The same image runs on the server and in the browser.
          </li>
        </ol>
      </section>

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
              <a href={`#${g.category}`}>{lawCategoryLabel(g.category)}</a>&nbsp;
              <span className="meta">{g.rules.length}</span>
            </li>
          ))}
          {ir?.skipped.length ? (
            <li>
              <a href="#set-aside">Set aside</a>&nbsp;<span className="meta">{ir.skipped.length}</span>
            </li>
          ) : null}
          <li>
            <a href="#compiled">Compiled law</a>
          </li>
          <li>
            <a href="#sources">Sources</a>&nbsp;<span className="meta">{law.sources.length}</span>
          </li>
        </ul>
      </nav>

      {groups.map((g) => (
        <section key={g.category} id={g.category} className={styles.group} aria-labelledby={`h-${g.category}`}>
          <h2 id={`h-${g.category}`}>{lawCategoryLabel(g.category)}</h2>
          <div className={styles.rules}>
            {g.rules.map((r) => (
              <RuleEntry
                key={r.id}
                rule={r}
                source={sources.get(r.source_id)}
                ir={irById.get(r.id)}
                skip={skipById.get(r.id)}
                ids={ruleIds}
              />
            ))}
          </div>
        </section>
      ))}

      {ir?.skipped.length ? (
        <section id="set-aside" className={styles.group} aria-labelledby="h-set-aside">
          <h2 id="h-set-aside">Set aside</h2>
          <p className={styles.groupNote}>
            These rules are verified and quoted above, but the engine does not use them in the math. Each one says why.
          </p>
          <SetAsideList st={ref.st} skipped={ir.skipped} rules={rulesById} />
        </section>
      ) : null}

      <section id="compiled" className={styles.group} aria-labelledby="h-compiled">
        <h2 id="h-compiled">Compiled law</h2>
        <p className={styles.groupNote}>
          The engine compiles {law.name}&apos;s rules into a law image and runs it as bytecode. Rule ids in the listing
          link back to the rules above.
        </p>
        <p className="meta">
          Verified rules SHA-256 <code className={styles.sha}>{sha256}</code>
        </p>
        {asm ? (
          <AsmView st={ref.st} name={law.name} asm={asm} ruleIds={ruleIds} lawSha={sha256} />
        ) : (
          // No listing was built for this state; the browser asks the engine on this device or the API.
          <AsmListing st={ref.st} />
        )}
      </section>

      <section id="sources" className={styles.group} aria-labelledby="h-sources">
        <h2 id="h-sources">Sources</h2>
        <SourceList sources={law.sources} rules={law.rules} />
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
