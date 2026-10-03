import { Fragment } from "react";

const RULE_ID = /\b[A-Z]{2}-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;

// Rule ids inside a summary ("see TX-SEIZED-1") become links to that rule on the law page.
// On the law page itself, samePage keeps the links as in-page anchors.
export default function Linkified({
  text,
  st,
  ids,
  samePage = false,
}: {
  text: string;
  st: string;
  ids: Set<string>;
  samePage?: boolean;
}) {
  const parts: (string | { id: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(RULE_ID)) {
    if (!ids.has(m[0])) continue;
    parts.push(text.slice(last, m.index), { id: m[0] });
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          <Fragment key={i}>{p}</Fragment>
        ) : (
          <a key={i} href={samePage ? `#${p.id}` : `/law/${st}#${p.id}`}>
            {p.id}
          </a>
        ),
      )}
    </>
  );
}
