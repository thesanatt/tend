"use client";

import { useI18n, useSummary } from "@/lib/i18n";

// A rule's own scope and condition, as the state page words them (lib/hedge.ts). The text is English, as
// rule summaries are; in Spanish the device translates it when it can, and says so when it cannot.
export default function RuleTerms({ text, className }: { text: string; className?: string }) {
  const { t, lang } = useI18n();
  const terms = useSummary(text);
  const english = terms.original && lang !== "en";
  return (
    <p className={className} lang={english ? "en" : undefined}>
      {terms.text}
      {english ? <span lang={lang}> {t.cite.summaryInEnglish}</span> : null}
    </p>
  );
}
