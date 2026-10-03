"use client";

import { useEffect, useState } from "react";
import { disassemble } from "@/lib/engine";
import styles from "./law.module.css";

const SOURCE_LABEL = {
  wasm: "Disassembled on this device by the WebAssembly engine (tdis).",
  api: "Disassembled by the law engine on the Tend server (tdis).",
  fixture: "Stand-in listing: the compiled engine is not connected yet, so this shows the shape of tdis output.",
};

function lineClass(line: string): string | undefined {
  const t = line.trim();
  if (t.startsWith(";")) return styles.asmComment;
  if (/^[\w.]+:$/.test(t) || t.startsWith(".")) return styles.asmLabel;
  return undefined;
}

export default function AsmListing({ st }: { st: string }) {
  const [state, setState] = useState<{ text: string; source: keyof typeof SOURCE_LABEL } | null | "loading">("loading");

  useEffect(() => {
    let live = true;
    disassemble(st)
      .then((r) => live && setState(r))
      .catch(() => live && setState(null));
    return () => {
      live = false;
    };
  }, [st]);

  if (state === "loading") return <p className="meta">Loading the compiled listing</p>;
  if (!state) {
    return <p className="meta">The compiled listing appears here once the law engine is connected for this state.</p>;
  }

  const lines = state.text.split("\n");
  return (
    <figure className={styles.asm}>
      <figcaption className="meta">{SOURCE_LABEL[state.source]}</figcaption>
      <pre className={styles.asmPre} tabIndex={0} aria-label="Compiled law listing">
        <code>
          {lines.map((line, i) => (
            <span key={i} className={lineClass(line)}>
              {line}
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
}
