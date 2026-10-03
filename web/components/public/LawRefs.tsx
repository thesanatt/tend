import type { Rule, Source } from "@/lib/types";
import { hostOf } from "./format";
import styles from "./public.module.css";

interface LawRefsProps {
  st: string;
  ids: string[];
  rules: Map<string, Rule>;
  sources: Map<string, Source>;
  // The visible text already is the rule's summary, so the panel shows only the quote.
  summaryShown?: boolean;
}

// The exact words behind one line, one tap away. A native <details>, so it works without JavaScript.
export default function LawRefs({ st, ids, rules, sources, summaryShown = false }: LawRefsProps) {
  const refs = ids.map((id) => ({ id, rule: rules.get(id), source: rules.has(id) ? undefined : sources.get(id) }));
  const shown = refs.filter((r) => r.rule || r.source);
  if (!shown.length) return null;
  const first = shown[0].rule?.pinpoint ?? shown[0].source?.title ?? shown[0].id;
  const more = shown.length - 1;

  return (
    <details className={styles.law}>
      <summary>
        <span className="visually-hidden">Show the law for this line: </span>
        <span className={styles.lawFirst}>{first}</span>
        {more > 0 ? <span className={styles.lawMore}>and {more} more</span> : null}
      </summary>
      <div className={styles.lawBody}>
        {shown.map(({ id, rule, source }) =>
          rule ? (
            <div key={id} className={styles.ref}>
              <p className={styles.refCite}>
                <strong>{rule.pinpoint}</strong>
                <a href={`/law/${st}#${rule.id}`} className={styles.refId}>
                  {rule.id}
                </a>
              </p>
              {summaryShown && shown.length === 1 ? null : <p className={styles.refSummary}>{rule.summary}</p>}
              <blockquote className={styles.quote} cite={sources.get(rule.source_id)?.url}>
                <p>
                  <mark>{rule.quote}</mark>
                </p>
              </blockquote>
              <RefLink rule={rule} source={sources.get(rule.source_id)} />
            </div>
          ) : source ? (
            <div key={id} className={styles.ref}>
              <p className={styles.refCite}>
                <strong>{source.title}</strong>
                <a href={`/law/${st}#${source.id}`} className={styles.refId}>
                  {source.id}
                </a>
              </p>
              <p className={styles.refSummary}>The program&apos;s own page, saved by Tend.</p>
              <p className={styles.refLink}>
                <a href={source.url} target="_blank" rel="noopener noreferrer">
                  Open it on {hostOf(source.url)}
                  <span className="visually-hidden"> (opens in a new tab)</span>
                </a>
              </p>
            </div>
          ) : null,
        )}
      </div>
    </details>
  );
}

function RefLink({ rule, source }: { rule: Rule; source?: Source }) {
  const href = rule.fragment_url ?? source?.url;
  if (!href) return null;
  return (
    <p className={styles.refLink}>
      <a href={href} target="_blank" rel="noopener noreferrer">
        {rule.fragment_url ? `Read this sentence on ${hostOf(href)}` : `Open the source on ${hostOf(href)}`}
        <span className="visually-hidden"> (opens in a new tab)</span>
      </a>
    </p>
  );
}
