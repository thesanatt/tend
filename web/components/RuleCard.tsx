import { formatTimestamp } from "@/lib/dates";
import type { Rule, Source } from "@/lib/types";
import styles from "./RuleCard.module.css";

interface RuleCardProps {
  rule: Rule;
  source?: Source;
  showSummary?: boolean;
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default function RuleCard({ rule, source, showSummary = true }: RuleCardProps) {
  const href = rule.fragment_url ?? source?.url;
  const isPdf = !rule.fragment_url && (source?.raw_path?.endsWith(".pdf") || /\.pdf($|\?)/i.test(source?.url ?? ""));
  return (
    <article className={styles.rule}>
      <p className={styles.cite}>
        <span className={styles.pinpoint}>{rule.pinpoint}</span>
        <span className={styles.id}>{rule.id}</span>
      </p>
      {showSummary ? <p className={styles.summary}>{rule.summary}</p> : null}
      <blockquote className={styles.quote} cite={source?.url}>
        <p>
          <mark>{rule.quote}</mark>
        </p>
      </blockquote>
      {href ? (
        <p className={styles.source}>
          <a href={href} target="_blank" rel="noopener noreferrer">
            {rule.fragment_url
              ? `Read this sentence on ${host(href)}`
              : `Open the ${isPdf ? "PDF" : "source"} on ${host(href)}`}
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
          {source ? (
            <span className={styles.provenance}>
              {source.title}. Saved {formatTimestamp(source.retrieved_at)}. SHA-256{" "}
              <code title={source.sha256}>{source.sha256.slice(0, 12)}</code>
            </span>
          ) : null}
        </p>
      ) : null}
    </article>
  );
}
