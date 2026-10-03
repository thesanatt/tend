"use client";

import { useState } from "react";
import type { Letter } from "@/lib/contracts";
import { useI18n } from "@/lib/i18n";
import type { LawIndex } from "@/lib/useLaw";
import Cite from "./Cite";
import FlowSheet from "./FlowSheet";
import styles from "./flow.module.css";

export function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// A ready letter or template. Tend never sends it; the survivor copies or saves it.
export default function LetterSheet({
  open,
  onClose,
  letter,
  law,
  tone = "default",
}: {
  open: boolean;
  onClose: () => void;
  letter: Letter | null;
  law: LawIndex;
  tone?: "default" | "held";
}) {
  const { t, lang } = useI18n();
  const [copied, setCopied] = useState(false);

  return (
    <FlowSheet
      open={open}
      onClose={() => {
        setCopied(false);
        onClose();
      }}
      title={letter ? (t.letters[letter.kind] ?? letter.title) : t.common.loading}
      tone={tone}
      footer={
        letter ? (
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(letter.body);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? t.common.copied : t.letters.copy}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => downloadText(`${letter.kind.replace(/_/g, "-")}.txt`, letter.body)}
            >
              {t.letters.save}
            </button>
          </div>
        ) : null
      }
    >
      {letter ? (
        <>
          <p>{t.letters.lead}</p>
          {lang !== "en" ? <p className={styles.note}>{t.letters.inEnglish}</p> : null}
          <pre className={styles.letter} lang="en">
            {letter.body}
          </pre>
          {letter.rule_ids.length ? (
            <p className="meta">
              {t.letters.cites}{" "}
              <Cite ruleIds={letter.rule_ids} law={law} subject={t.letters[letter.kind] ?? letter.title} />
            </p>
          ) : null}
          <p className="meta">{t.letters.neverSent}</p>
          <p role="status" className="visually-hidden">
            {copied ? t.common.copied : ""}
          </p>
        </>
      ) : (
        <p className="meta">{t.common.loading}</p>
      )}
    </FlowSheet>
  );
}
