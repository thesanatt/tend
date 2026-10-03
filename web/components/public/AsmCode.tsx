"use client";

import { useMemo } from "react";
import { asmLine, directiveAnchor } from "./asm";
import styles from "./law.module.css";

// The listing text crosses to the browser once, as a string, instead of as a tree of spans; the
// server still renders it in full, so it reads without JavaScript.
export default function AsmCode({ text, ruleIds, name }: { text: string; ruleIds: string[]; name: string }) {
  const lines = useMemo(() => {
    const ids = new Set(ruleIds);
    return text
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => asmLine(line, ids));
  }, [text, ruleIds]);

  return (
    <pre className={styles.asmPre} tabIndex={0} aria-label={`Compiled law listing for ${name}, ${lines.length} lines`}>
      <code>
        {lines.map((segs, i) => (
          <span key={i}>
            {segs.map((seg, j) => {
              const anchor = directiveAnchor(seg);
              const cls = seg.k ? styles[`asm_${seg.k}`] : undefined;
              if (seg.id) {
                return (
                  <a key={j} href={`#${seg.id}`} className={cls}>
                    {seg.t}
                  </a>
                );
              }
              return cls || anchor ? (
                <span key={j} id={anchor ?? undefined} className={cls}>
                  {seg.t}
                </span>
              ) : (
                seg.t
              );
            })}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}
