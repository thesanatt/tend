"use client";

import { useI18n, useSummary } from "@/lib/i18n";
import type { Rule, Source } from "@/lib/types";
import styles from "./cite.module.css";

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// A rule as the survivor sees it: the plain summary first, then the exact words of the law in their
// original language, then where the sentence lives.
export default function LawQuote({ rule, source }: { rule: Rule; source?: Source }) {
  const { t, f, lang } = useI18n();
  const summary = useSummary(rule.summary);
  const href = rule.fragment_url ?? source?.url;
  const isPdf = !rule.fragment_url && (source?.raw_path?.endsWith(".pdf") || /\.pdf($|\?)/i.test(source?.url ?? ""));
  return (
    <article className={styles.rule}>
      <p className={styles.ruleHead}>
        <span className={styles.pinpoint}>{rule.pinpoint}</span>
        <span className={styles.ruleId}>{rule.id}</span>
      </p>
      {summary.text ? (
        <p className={styles.summary} lang={summary.original && lang !== "en" ? "en" : undefined}>
          {summary.text}
          {summary.original && lang !== "en" ? <span className={styles.note}> {t.cite.summaryInEnglish}</span> : null}
        </p>
      ) : null}
      <blockquote className={styles.quote} cite={source?.url} lang="en">
        <p>
          <mark>{rule.quote}</mark>
        </p>
      </blockquote>
      {lang !== "en" ? <p className={styles.note}>{t.cite.quoteOriginal}</p> : null}
      {href ? (
        <p className={styles.source}>
          <a href={href} target="_blank" rel="noopener noreferrer">
            {rule.fragment_url ? t.cite.readOn(host(href)) : isPdf ? t.cite.openPdf(host(href)) : t.cite.openSource(host(href))}
            <span className="visually-hidden"> {t.common.newTab}</span>
          </a>
          {source ? (
            <span className={styles.provenance}>
              {t.cite.saved(
                source.title,
                /^\d{4}-\d{2}-\d{2}/.test(source.retrieved_at) ? f.date(source.retrieved_at.slice(0, 10)) : source.retrieved_at,
              )}{" "}
              <code title={source.sha256}>{source.sha256.slice(0, 12)}</code>
            </span>
          ) : null}
        </p>
      ) : null}
    </article>
  );
}
