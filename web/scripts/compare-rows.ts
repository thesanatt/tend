// Prints every row of /compare as JSON, so each cell can be checked against the words it rests on: the cell's
// text as the page shows it, its lines, and each cited rule's quote, summary, pinpoint, params, whether the
// normalizer set it aside, and the kind of source it quotes. Every cited rule is at /law/ST#RULE-ID on the site.
// Each row also carries the sources those rules quote and the jurisdiction's coverage.not_found, what Tend's
// research looked for and did not find, for the cells that say Tend has not verified something.
// usage, from web/: npx tsx scripts/compare-rows.ts > compare-rows.json
import { buildCompareRow, COLUMNS, lineCites, type CompareLine } from "../components/public/compare";
import { allStates, loadIr, loadLaw } from "../components/public/data";

// A line's words in the order the page shows them.
function words(line: CompareLine): string {
  if (line.kind === "key") return `${line.key.big}, ${line.key.small}`;
  if (line.kind === "gap") return line.text;
  if (line.kind === "more") return `${line.text} (${line.href}: ${line.ids.join(", ")})`;
  const { label, text, details = [] } = line.fact;
  return [[label, text].filter(Boolean).join(" "), ...details.map((d) => d.text)].join(" / ");
}

const rows = allStates().flatMap((ref) => {
  const loaded = loadLaw(ref.st);
  if (!loaded) return [];
  const { law } = loaded;
  const ir = loadIr(ref.st);
  const row = buildCompareRow(law, ir);
  const rules = new Map(law.rules.map((r) => [r.id, r]));
  const skipped = new Map((ir?.skipped ?? []).map((s) => [s.id, s.reason]));
  const kinds = new Map(law.sources.map((s) => [s.id, s.kind]));
  const cells = row.cells.map((cell) => {
    const cited = [...new Set(cell.lines.flatMap(lineCites))].map((id) => rules.get(id)!);
    return {
      column: cell.id,
      title: COLUMNS.find((c) => c.id === cell.id)?.title,
      text: cell.lines.map(words).join(" | "),
      lines: cell.lines,
      rules: cited.map((r) => ({
        id: r.id,
        category: r.category,
        pinpoint: r.pinpoint,
        summary: r.summary,
        quote: r.quote,
        params: r.params ?? {},
        set_aside: skipped.get(r.id) ?? null,
        source_id: r.source_id,
        source_kind: kinds.get(r.source_id) ?? null,
      })),
    };
  });
  const used = new Set(cells.flatMap((c) => c.rules.map((r) => r.source_id)));
  const sources = Object.fromEntries(
    law.sources
      .filter((s) => used.has(s.id))
      .map((s) => [s.id, { title: s.title, kind: s.kind, url: s.url, retrieved_at: s.retrieved_at }]),
  );
  return [
    {
      st: row.st,
      name: row.name,
      page: `/${row.st.toLowerCase()}`,
      not_found: law.coverage?.not_found ?? [],
      cells,
      sources,
    },
  ];
});

if (!rows.length) {
  console.error("No rules found under public/data. Run this from web/.");
  process.exit(1);
}
// One jurisdiction per line: still one JSON array, and a diff shows which state changed.
process.stdout.write(`[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]\n`);
