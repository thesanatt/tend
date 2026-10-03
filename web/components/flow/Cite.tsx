"use client";

import Link from "next/link";
import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { Rule } from "@/lib/types";
import type { LawIndex } from "@/lib/useLaw";
import FlowSheet from "./FlowSheet";
import LawQuote from "./LawQuote";
import styles from "./cite.module.css";

interface CiteProps {
  ruleIds: string[];
  law: LawIndex;
  // What the citation is about, read to screen readers and shown at the top of the sheet.
  subject: string;
  // One plain sentence on why these rules matter here.
  explain?: string;
  title?: string;
  tone?: "default" | "held";
}

// The pinpoint as a button. It opens the plain summary, the exact quote, and a link to the source.
export default function Cite({ ruleIds: given, law, subject, explain, title, tone = "default" }: CiteProps) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const ruleIds = [...new Set(given)];
  const rules = ruleIds.map((id) => law.rule(id)).filter((r): r is Rule => Boolean(r));
  const first = rules[0];
  const label = first?.pinpoint ?? ruleIds[0] ?? t.cite.why;
  const more = Math.max(0, ruleIds.length - 1);
  const missing = ruleIds.filter((id) => !law.rule(id));

  return (
    <>
      <button type="button" className={styles.cite} onClick={() => setOpen(true)} aria-haspopup="dialog" title={label}>
        <span className={styles.label}>{label}</span>
        {more > 0 ? <span className={styles.more}> +{more}</span> : null}
        <span className="visually-hidden">: {t.cite.showLaw(subject)}</span>
      </button>
      <FlowSheet open={open} onClose={() => setOpen(false)} title={title ?? t.cite.title} tone={tone}>
        <div className={styles.intro}>
          <p className={styles.subject}>{subject}</p>
          {explain ? <p>{explain}</p> : null}
          {lang !== "en" && rules.length ? <p className="meta">{t.cite.quoteOriginal}</p> : null}
        </div>
        {!ruleIds.length ? <p>{t.cite.noRule}</p> : null}
        {rules.map((r) => (
          <section key={r.id} className={styles.group}>
            <LawQuote rule={r} source={law.source(r.source_id)} languageNote={false} />
          </section>
        ))}
        {law.law && missing.length ? <p className="meta">{t.cite.missing(missing.join(", "))}</p> : null}
        {!law.law && ruleIds.length ? <p className="meta">{t.common.loading}</p> : null}
        {law.law ? (
          <p className="meta">
            <Link href={`/law/${law.law.jurisdiction}`}>{t.cite.allRules(law.law.name)}</Link>
          </p>
        ) : null}
      </FlowSheet>
    </>
  );
}
