"use client";

import Link from "next/link";
import { useState } from "react";
import { categoryLabel } from "@/lib/categories";
import { statusCopy } from "@/lib/status";
import type { LawIndex } from "@/lib/useLaw";
import type { Rule } from "@/lib/types";
import RuleCard from "./RuleCard";
import Sheet from "./Sheet";
import styles from "./Citation.module.css";

interface CitationProps {
  ruleIds: string[];
  status: string;
  law: LawIndex;
  subject: string;
  // Overrides the status sentence, e.g. for a cap or a deadline.
  explain?: string;
  title?: string;
}

function groupByCategory(rules: Rule[]): [string, Rule[]][] {
  const groups = new Map<string, Rule[]>();
  for (const r of rules) groups.set(r.category, [...(groups.get(r.category) ?? []), r]);
  return [...groups.entries()];
}

export default function Citation({ ruleIds, status, law, subject, explain, title }: CitationProps) {
  const [open, setOpen] = useState(false);
  const copy = statusCopy(status);
  const rules = ruleIds.map((id) => law.rule(id)).filter((r): r is Rule => Boolean(r));
  const first = rules[0];
  const more = ruleIds.length - 1;
  const st = law.law?.jurisdiction;

  const label = !ruleIds.length ? "Why" : first ? first.pinpoint : ruleIds[0];

  return (
    <>
      <button type="button" className={styles.cite} onClick={() => setOpen(true)} aria-haspopup="dialog" title={label}>
        <span className={styles.label}>{label}</span>
        {more > 0 ? <span className={styles.more}> +{more}</span> : null}
        <span className="visually-hidden">: show the law for {subject}</span>
      </button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={title ?? copy.sheetTitle}
        tone={status === "held" ? "held" : "default"}
      >
        <div className={styles.intro}>
          <p className={styles.subject}>{subject}</p>
          <p>{explain ?? copy.explain}</p>
        </div>
        {!ruleIds.length && law.law ? (
          <p>
            Tend checked all {law.law.rules.length} verified rules for {law.law.name}.{" "}
            {st ? <Link href={`/law/${st}`}>See every rule Tend has verified for {law.law.name}</Link> : null}
          </p>
        ) : null}
        {groupByCategory(rules).map(([category, group]) => (
          <section key={category} className={styles.group}>
            <h3 className={styles.groupTitle}>{categoryLabel(category)}</h3>
            {group.map((r) => (
              <RuleCard key={r.id} rule={r} source={law.source(r.source_id)} />
            ))}
          </section>
        ))}
        {rules.length < ruleIds.length ? (
          <p className="meta">
            Some rules are still loading or were not found: {ruleIds.filter((id) => !law.rule(id)).join(", ")}
          </p>
        ) : null}
      </Sheet>
    </>
  );
}
