// One row per jurisdiction for /compare: five facts side by side, each in the words its state page uses for it.
// The cells hold the state page's own key facts and lines, built by the same code (summary.ts stateParts), so the
// two pages cannot drift apart. Where the state page has nothing on a fact, the cell says that is a gap in Tend's
// research. scripts/compare-rows.ts prints every row with its rules' quotes, so each cell can be checked.
import type { Jurisdiction } from "@/lib/types";
import { sectionNote, stateParts, type Fact, type KeyFact } from "./summary";
import type { IrSummary } from "./types";

export type ColumnId = "deadline" | "report" | "total" | "counseling" | "exam";

// section: where the state page says the most about the fact (app/[st]/page.tsx). more: what "N more" counts,
// for one rule and for several. The counseling row already shows every rule it cites.
export const COLUMNS: { id: ColumnId; title: string; section: string; more?: [string, string] }[] = [
  { id: "deadline", title: "Deadline to apply", section: "deadline", more: ["deadline rule", "deadline rules"] },
  { id: "report", title: "Police report", section: "police", more: ["police report rule", "police report rules"] },
  { id: "total", title: "Total cap", section: "costs", more: ["rule on the total", "rules on the total"] },
  { id: "counseling", title: "Counseling limits", section: "costs" },
  { id: "exam", title: "Forensic exam bill", section: "exam", more: ["exam rule", "exam rules"] },
];

// A line of a cell: a key fact from the top of the state page, a line from one of its sections (a rule's own
// summary, a templated line, or a page note), Tend's words for a gap, or a link to the rest of the state page's
// rules on the fact.
export type CompareLine =
  | { kind: "key"; key: KeyFact }
  | { kind: "fact"; fact: Fact }
  | { kind: "gap"; text: string }
  | { kind: "more"; text: string; href: string; ids: string[] };

export interface CompareCell {
  id: ColumnId;
  lines: CompareLine[];
}

export interface CompareRow {
  st: string;
  name: string;
  cells: CompareCell[];
}

// What the state page says about one fact.
interface Topic {
  // The section's page note, which the section shows first.
  note: Fact | null;
  // The key fact at the top of the page, and the lines that add to it.
  key: KeyFact | null;
  extra: Fact[];
  // Every line of the section on the fact.
  facts: Fact[];
  // Tend's words where the page has nothing on it.
  gap: string;
}

// The rule ids a line cites. A fact's details each cite their own rule.
export function lineCites(line: CompareLine): string[] {
  if (line.kind === "key") return line.key.cites;
  if (line.kind === "fact") return [...new Set([...line.fact.cites, ...(line.fact.details ?? []).map((d) => d.cite)])];
  return [];
}

const lines = (facts: Fact[]): CompareLine[] => facts.map((fact) => ({ kind: "fact", fact }));

// The note first, as the section shows it, then the key fact with the lines that add to it, or, where the page has
// no key fact, every line of the section. With nothing at all, the gap. When the section cites rules the cell does
// not show, the cell ends with a link to them there.
function cell(id: ColumnId, st: string, t: Topic): CompareCell {
  const first = lines(t.note ? [t.note] : []);
  const shown: CompareLine[] = t.key
    ? [...first, { kind: "key", key: t.key }, ...lines(t.extra)]
    : t.facts.length
      ? [...first, ...lines(t.facts)]
      : [...first, { kind: "gap", text: t.gap }];
  const cited = new Set(shown.flatMap(lineCites));
  const rest = [...new Set(lines(t.facts).flatMap(lineCites))].filter((x) => !cited.has(x));
  const column = COLUMNS.find((c) => c.id === id)!;
  if (!rest.length || !column.more) return { id, lines: shown };
  const more: CompareLine = {
    kind: "more",
    text: `${rest.length} more ${column.more[rest.length === 1 ? 0 : 1]}`,
    href: `/${st.toLowerCase()}#${column.section}`,
    ids: rest,
  };
  return { id, lines: [...shown, more] };
}

export function buildCompareRow(law: Jurisdiction, ir: IrSummary | null): CompareRow {
  const { total, covered, exam, report, deadline } = stateParts(law, ir);
  const { name, jurisdiction: st } = law;
  const note = (section: string) => sectionNote(law, section);
  // The counseling row of "What the program can pay for": its name, then each limit on it in its rule's words.
  const counseling = covered.rowFacts[covered.rows.findIndex((r) => r.expense === "counseling")];

  const cells: Record<ColumnId, CompareCell> = {
    // The deadline section always has a line: without a rule, Tend's note that it has not verified one.
    deadline: cell("deadline", st, {
      note: note("deadline"),
      key: deadline.key,
      extra: [],
      facts: deadline.facts,
      gap: `Tend has not verified a filing deadline for ${name}.`,
    }),
    // Where the key fact says only that other records count, the section's first line names some of them.
    report: cell("report", st, {
      note: note("police"),
      key: report.key,
      extra: report.leadNamesRecords && report.lead ? [report.lead] : [],
      facts: report.facts,
      gap: `Tend has not verified a police report rule for ${name}.`,
    }),
    // The costs section's note is about the costs it lists, not the total, so it stays on the state page.
    total: cell("total", st, {
      note: null,
      key: total.key,
      extra: [],
      facts: total.facts,
      gap: `Tend has not verified a total cap for ${name}.`,
    }),
    // The row's details are its limits, so a row without any says that is a gap.
    counseling: counseling
      ? {
          id: "counseling",
          lines: [
            { kind: "fact", fact: counseling },
            ...(counseling.details?.length
              ? []
              : [{ kind: "gap" as const, text: "Tend has not verified a cap on it." }]),
          ],
        }
      : {
          id: "counseling",
          lines: [{ kind: "gap", text: `Tend has not verified a rule that covers counseling for ${name}.` }],
        },
    // The line on billing insurance follows the exam's key fact, as it follows the headline on the state page.
    exam: cell("exam", st, {
      note: note("exam"),
      key: exam.key,
      extra: exam.insurance ? [exam.insurance] : [],
      facts: exam.facts,
      gap: `Tend has not verified an exam billing rule for ${name}.`,
    }),
  };
  return { st, name, cells: COLUMNS.map((c) => cells[c.id]) };
}
