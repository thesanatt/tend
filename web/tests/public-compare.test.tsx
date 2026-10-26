// @vitest-environment jsdom
// /compare may say only what each state's own page says: every cell holds the key fact or the lines the state page
// shows for that fact, in the same words and with the same rules cited, every rule it cites is a verified rule of
// that state, a fact the state page lacks reads as a gap in Tend's research, and the page's own copy is plain ASCII.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import StatePage from "@/app/[st]/page";
import ComparePage, { metadata } from "@/app/compare/page";
import {
  buildCompareRow,
  COLUMNS,
  lineCites,
  type ColumnId,
  type CompareCell,
  type CompareLine,
  type CompareRow,
} from "@/components/public/compare";
import { savedDays } from "@/components/public/corrections";
import { longDate } from "@/components/public/format";
import { SITE_CARDS, siteCardAlt } from "@/components/public/og/siteCard";
import { buildStateSummary, type Fact, type KeyFact, type StateSummary } from "@/components/public/summary";
import type { IrSummary } from "@/components/public/types";
import type { Jurisdiction } from "@/lib/types";

const web = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(web, "..");
const states = readdirSync(path.join(web, "public/data/law"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5))
  .sort();

function load(st: string): { law: Jurisdiction; ir: IrSummary } {
  return {
    law: JSON.parse(readFileSync(path.join(web, "public/data/law", `${st}.json`), "utf8")),
    ir: JSON.parse(readFileSync(path.join(web, "public/data/ir", `${st}.json`), "utf8")),
  };
}

// The rule ids in rules/verified, where verify.py keeps the rules whose quotes it checked.
function verified(st: string): Set<string> {
  const file = JSON.parse(readFileSync(path.join(repo, "rules/verified", `${st}.json`), "utf8")) as Jurisdiction;
  return new Set(file.rules.map((r) => r.id));
}

const built = new Map(
  states.map((st) => {
    const { law, ir } = load(st);
    return [st, { law, row: buildCompareRow(law, ir), summary: buildStateSummary(law, ir) }];
  }),
);

const cellOf = (row: CompareRow, id: ColumnId): CompareCell => row.cells.find((c) => c.id === id)!;
const said = (cell: CompareCell) => cell.lines.filter((l) => l.kind !== "more");

const K = (key: KeyFact): CompareLine => ({ kind: "key", key });
const F = (fact: Fact): CompareLine => ({ kind: "fact", fact });
const GAP = { kind: "gap", text: expect.stringMatching(/^Tend has not verified /) };
// Tend's own notes on a section (page_notes), which the section shows first.
const pageNotes = (facts: Fact[]) => facts.filter((f) => f.kind === "note" && f.key.endsWith("-note"));

// What the state page shows for each column's fact, read from the page's own summary: the key fact at the top of
// the page with its section's note before it and the lines that add to it, or, where there is no key fact, every
// line the section has on it.
function statePage(summary: StateSummary): Record<ColumnId, { lines: unknown[]; topic: Fact[] }> {
  const section = (id: string) => summary.sections.find((s) => s.id === id)?.facts ?? [];
  const key = (id: KeyFact["id"]) => summary.keyFacts.find((k) => k.id === id) ?? null;
  const shown = (k: KeyFact | null, facts: Fact[], extra: Fact[]) =>
    k
      ? [...pageNotes(facts).map(F), K(k), ...extra.map(F)]
      : facts.length
        ? facts.map(F)
        : [...pageNotes(facts).map(F), GAP];

  const deadline = section("deadline");
  const police = section("police");
  const report = key("report");
  // A key fact that says only that other records count leaves naming them to the section's first line.
  const lead = report?.small.startsWith("not the only record that counts")
    ? police.filter((f) => f.key === "report-lead")
    : [];
  const totals = section("costs").filter((f) => /^total(-|$)/.test(f.key));
  const counseling = section("costs").find((f) => f.key.startsWith("covered-counseling-"));
  const exam = section("exam");
  return {
    deadline: { lines: shown(key("deadline"), deadline, []), topic: deadline },
    report: { lines: shown(report, police, lead), topic: police },
    total: { lines: shown(key("total"), totals, []), topic: totals },
    counseling: {
      lines: counseling ? [F(counseling), ...(counseling.details?.length ? [] : [GAP])] : [GAP],
      topic: counseling ? [counseling] : [],
    },
    exam: {
      lines: shown(
        key("exam"),
        exam,
        exam.filter((f) => f.key.startsWith("exam-insurance-")),
      ),
      topic: exam,
    },
  };
}

// The words a line puts on the page, in order, as the page renders them (the link to each rule says "Rule ID").
function rendered(line: CompareLine, name: string): string {
  const rule = (ids: string[]) => ids.map((id) => `Rule ${id}`).join("");
  if (line.kind === "key") return `${line.key.big}${line.key.small}${rule(line.key.cites)}`;
  if (line.kind === "gap") return line.text;
  if (line.kind === "more") return `${line.text} on the ${name} page`;
  const { label, text, cites, details = [], kind } = line.fact;
  if (kind === "note") return text;
  const own = cites.filter((id) => !details.some((d) => d.cite === id));
  return `${label ? `${label}${text ? ` ${text}` : ""}` : text}${rule(own)}${details.map((d) => `${d.text}${rule([d.cite])}`).join("")}`;
}

// The words of a line that come from the state page.
function words(line: CompareLine): string[] {
  if (line.kind === "key") return [line.key.big, line.key.small];
  if (line.kind === "fact")
    return [line.fact.label ?? "", line.fact.text, ...(line.fact.details ?? []).map((d) => d.text)];
  return [];
}

describe("the comparison rows", () => {
  it("has one row per jurisdiction, 51 in all, each with the five columns in order", () => {
    expect(built.size).toBe(51);
    for (const { row } of built.values()) expect(row.cells.map((c) => c.id)).toEqual(COLUMNS.map((c) => c.id));
    expect(COLUMNS.map((c) => c.title)).toEqual([
      "Deadline to apply",
      "Police report",
      "Total cap",
      "Counseling limits",
      "Forensic exam bill",
    ]);
  });

  it.each(states)("%s: every cell says what the state page shows for that fact, and nothing else", (st) => {
    const { row, summary } = built.get(st)!;
    const page = statePage(summary);
    for (const column of COLUMNS) {
      const cell = cellOf(row, column.id);
      expect(said(cell), `${st} ${column.id}`).toEqual(page[column.id].lines);
    }
  });

  it.each(states)("%s: a cell links to the rest of the state page's rules on the fact, and counts them", (st) => {
    const { row, summary } = built.get(st)!;
    const page = statePage(summary);
    for (const column of COLUMNS) {
      const cell = cellOf(row, column.id);
      const cited = new Set(cell.lines.flatMap(lineCites));
      const rest = [...new Set(page[column.id].topic.map(F).flatMap(lineCites))].filter((id) => !cited.has(id));
      const more = cell.lines.filter((l) => l.kind === "more");
      if (!rest.length || column.id === "counseling") {
        expect(more, `${st} ${column.id}`).toEqual([]);
        continue;
      }
      expect(more).toEqual([
        {
          kind: "more",
          text: expect.stringMatching(new RegExp(`^${rest.length} more `)),
          href: `/${st.toLowerCase()}#${column.section}`,
          ids: rest,
        },
      ]);
      expect(cell.lines.at(-1)).toBe(more[0]);
      expect(summary.sections.some((s) => s.id === column.section)).toBe(true);
    }
  });

  it.each(states)("%s: every rule a cell cites or counts is one of the state's verified rules", (st) => {
    const { row, law } = built.get(st)!;
    const ids = verified(st);
    expect(ids).toEqual(new Set(law.rules.map((r) => r.id)));
    for (const cell of row.cells) {
      for (const line of cell.lines) {
        const named = line.kind === "more" ? line.ids : lineCites(line);
        for (const id of named) expect(ids.has(id), `${st} ${cell.id} cites ${id}`).toBe(true);
        if (line.kind === "fact" && line.fact.kind === "law") expect(lineCites(line).length).toBeGreaterThan(0);
        if (line.kind === "key") expect(line.key.cites.length).toBeGreaterThan(0);
      }
    }
  });

  it.each(states)(
    "%s: a cell says Tend has not verified something only where the state page has nothing on it",
    (st) => {
      const { row, summary } = built.get(st)!;
      for (const cell of row.cells) {
        const gaps = cell.lines.filter((l) => l.kind === "gap");
        if (!gaps.length) continue;
        const law = cell.lines.filter((l) => l.kind === "key" || (l.kind === "fact" && l.fact.kind === "law"));
        if (cell.id === "counseling") {
          // The counseling row is there, with no limit under it.
          expect(law).toHaveLength(1);
          expect(law[0].kind === "fact" && law[0].fact.details).toBeUndefined();
        } else {
          expect(law, `${st} ${cell.id}`).toEqual([]);
          expect(summary.keyFacts.some((k) => k.id === cell.id)).toBe(false);
        }
      }
    },
  );
});

describe("cells that need a second look", () => {
  const cell = (st: string, id: ColumnId) => cellOf(built.get(st)!.row, id);
  const kinds = (st: string, id: ColumnId) =>
    cell(st, id).lines.map((l) => (l.kind === "fact" ? `${l.fact.kind}:${l.fact.key}` : l.kind));

  it("Michigan, the demo state, matches /mi", () => {
    expect(cell("MI", "deadline").lines).toEqual([
      K({
        id: "deadline",
        big: "5 years",
        small: "to apply, from the date it happened, with exceptions",
        cites: ["MI-FILE-1", "MI-FILE-2", "MI-FILE-3"],
      }),
    ]);
    expect(kinds("MI", "report")).toEqual(["note:police-note", "key", "more"]);
    expect(cell("MI", "exam").lines.map((l) => words(l).filter(Boolean).join(" "))).toEqual([
      "$0 what the forensic exam itself should cost you",
      "Your insurance can be billed for it only if you agree.",
      "",
    ]);
    expect(cell("MI", "counseling").lines).toHaveLength(1);
    const [row] = cell("MI", "counseling").lines;
    expect(row.kind === "fact" && row.fact.details?.map((d) => d.cite)).toEqual(["MI-CAP-2", "MI-CAP-3", "MI-CAP-4"]);
  });

  it("shows a page note first, as the state page does", () => {
    for (const [st, id] of [
      ["LA", "deadline"],
      ["MD", "report"],
      ["NV", "report"],
      ["SC", "report"],
      ["VA", "report"],
    ] as const) {
      const [first] = cell(st, id).lines;
      expect(first.kind === "fact" && first.fact.kind === "note" && first.fact.text, `${st} ${id}`).toMatch(/^Note: /);
    }
    // Louisiana's note points to the line below it, which cites the Legislature's summary of the Act.
    expect(kinds("LA", "deadline")).toEqual(["note:deadline-note", "key"]);
  });

  it("names the other records that count where the key fact says only that some do", () => {
    const named = [...built]
      .filter(([, { row }]) =>
        cellOf(row, "report").lines.some((l) => l.kind === "fact" && l.fact.key === "report-lead"),
      )
      .map(([st]) => st);
    expect(named).toEqual(["CA", "DE", "GA", "LA", "MA", "MD", "NM", "NV", "NY", "UT", "VA"]);
    expect(words(cell("CA", "report").lines[1]).join(" ")).toContain("like a forensic exam or a protective order");
  });

  it("gives the state page's own lines where it has no key fact", () => {
    expect(kinds("AZ", "deadline")).toEqual(["law:deadline-AZ-DEAD-1", "law:deadline-AZ-DEAD-2"]);
    expect(kinds("CO", "deadline")).toEqual(["note:deadline-note", "law:deadline-CO-DEADLINE-1"]);
    expect(kinds("CT", "total")).toEqual([
      "law:total-CT-CAP-1",
      "law:total-CT-CAP-2",
      "law:total-CT-CAP-6",
      "law:total-CT-CAP-7",
    ]);
    // Wyoming's only no-bill rule covers exams reported to police, so its page has no exam headline.
    expect(kinds("WY", "exam")[0]).toBe("law:exam-no-bill-WY-EXAM-2");
    for (const st of ["HI", "ID", "RI", "WY"]) {
      for (const l of cell(st, "exam").lines) expect(l.kind, st).not.toBe("key");
    }
  });

  it("says a gap is Tend's, in the state page's words where it has them", () => {
    expect(words(cell("KY", "deadline").lines[0])).toContain(
      "Tend has not verified a filing deadline for Kentucky. Ask the program before you wait.",
    );
    expect(cell("KY", "report").lines).toEqual([
      { kind: "gap", text: "Tend has not verified a police report rule for Kentucky." },
    ]);
    expect(cell("IA", "total").lines).toEqual([{ kind: "gap", text: "Tend has not verified a total cap for Iowa." }]);
    expect(cell("NY", "total").lines).toEqual([
      { kind: "gap", text: "Tend has not verified a total cap for New York." },
    ]);
    expect(cell("CO", "counseling").lines.at(-1)).toEqual({ kind: "gap", text: "Tend has not verified a cap on it." });
  });
});

describe("the /compare page", () => {
  const html = renderToStaticMarkup(ComparePage());
  const doc = new DOMParser().parseFromString(html, "text/html");
  const text = (doc.body.textContent ?? "").replace(/\s+/g, " ");

  it("is a real table with a caption and scoped headers, one row per jurisdiction", () => {
    const table = doc.querySelector("table")!;
    expect(table.querySelector("caption")?.textContent).toBeTruthy();
    expect([...table.querySelectorAll('thead th[scope="col"]')].map((th) => th.textContent)).toEqual([
      "State",
      ...COLUMNS.map((c) => c.title),
    ]);
    const rows = [...table.querySelectorAll("tbody tr")];
    // In order of name, as the law garden's list has them.
    const byName = [...built.values()].sort((a, b) => a.law.name.localeCompare(b.law.name));
    expect(rows.map((tr) => tr.id)).toEqual(byName.map(({ row }) => row.st.toLowerCase()));
    for (const tr of rows) {
      const th = tr.querySelector('th[scope="row"] a')!;
      expect(th.getAttribute("href")).toBe(`/${tr.id}`);
      expect(th.textContent).toBe(built.get(tr.id.toUpperCase())!.law.name);
      expect(tr.querySelectorAll("td")).toHaveLength(5);
    }
  });

  it.each(states)("%s: each cell shows exactly its lines' words, with the column's name for the card", (st) => {
    const { row, law } = built.get(st)!;
    const cells = [...doc.querySelectorAll(`tr#${st.toLowerCase()} td`)];
    expect(cells).toHaveLength(5);
    cells.forEach((td, i) => {
      const expected = `${COLUMNS[i].title}${row.cells[i].lines.map((l) => rendered(l, law.name)).join("")}`;
      expect(td.textContent, `${st} ${COLUMNS[i].id}`).toBe(expected);
    });
  });

  it("links every rule to its place on the law page, and each more link to a section of the state page", () => {
    const links = [...doc.querySelectorAll("tbody td a")].map((a) => a.getAttribute("href")!);
    expect(links).toContain("/law/MI#MI-FILE-1");
    for (const href of links) {
      const law = href.match(/^\/law\/([A-Z]{2})#(.+)$/);
      if (law) {
        expect(verified(law[1]).has(law[2]), href).toBe(true);
        continue;
      }
      const [page, hash] = href.split("#");
      const st = page.slice(1).toUpperCase();
      expect(
        built.get(st)!.summary.sections.map((s) => s.id),
        href,
      ).toContain(hash);
    }
  });

  it("says what it shows, how current it is, what a gap means, and that the program decides", () => {
    expect(text).toContain("in the same words as its page on Tend.");
    expect(text).toContain("A code like MI-FILE-1 opens that rule");
    // The days every program's sources were saved, said as the state pages say their own.
    const saved = savedDays([...built.values()].flatMap(({ law }) => law.sources))!;
    expect(text).toMatch(/Tend saved copies of this page's sources (on|between) /);
    expect(text).toContain(`${longDate(saved.last)} and checked every quote against those copies word for word.`);
    expect(text).toContain("When a cell says Tend has not verified something, that is a gap in Tend's research.");
    expect(text).toContain("It does not mean the state has no such rule.");
    expect(text).toContain("Tend is not legal advice. The program decides every claim.");
  });

  it("is plain ASCII with no dashes, in the page and in its source", () => {
    expect(text).toMatch(/^[\x20-\x7e]*$/);
    expect(text).not.toMatch(/ - |--/);
    for (const file of [
      "app/compare/page.tsx",
      "app/compare/compare.module.css",
      "app/compare/card.png/route.tsx",
      "components/public/compare.ts",
      "scripts/compare-rows.ts",
    ]) {
      expect(readFileSync(path.join(web, file), "utf8"), file).toMatch(/^[\x00-\x7f]*$/);
    }
  });

  it("loads nothing from another site", () => {
    for (const el of doc.querySelectorAll("script[src], img[src], iframe, link[href]")) {
      expect((el.getAttribute("src") ?? el.getAttribute("href"))!.startsWith("/")).toBe(true);
    }
    for (const a of doc.querySelectorAll("a[href]")) expect(a.getAttribute("href")).toMatch(/^[/#]/);
  });

  it("has a title, a description, and its own link card", () => {
    expect(metadata.title).toBe("Compare the states");
    expect(metadata.description).toMatch(/^[\x20-\x7e]+$/);
    const card = SITE_CARDS.compare;
    expect(card).toMatchObject({ path: "/compare", heading: "Compare the states" });
    // No number that could go stale as rules change.
    expect(card.sentence).not.toMatch(/\d/);
    expect(metadata.openGraph).toMatchObject({
      title: "Compare the states",
      description: card.sentence,
      url: "/compare",
      images: [{ url: "/compare/card.png", alt: siteCardAlt("compare") }],
    });
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image", description: card.sentence });
  });
});

describe("the state pages say the same words", () => {
  it.each(states)(
    "%s: every word a cell takes from the state page is on the state page",
    async (st) => {
      const { row } = built.get(st)!;
      const html = renderToStaticMarkup(await StatePage({ params: Promise.resolve({ st: st.toLowerCase() }) }));
      const page = (new DOMParser().parseFromString(html, "text/html").body.textContent ?? "").replace(/\s+/g, " ");
      for (const cell of row.cells) {
        for (const w of cell.lines.flatMap(words).filter(Boolean)) {
          expect(page.includes(w.replace(/\s+/g, " ")), `${st} ${cell.id}: ${w}`).toBe(true);
        }
      }
    },
    30_000,
  );
});

describe("scripts/compare-rows.ts", () => {
  it("prints every row with each cited rule's quote and summary", { timeout: 60_000 }, () => {
    const out = execFileSync("npx", ["tsx", "scripts/compare-rows.ts"], { cwd: web, encoding: "utf8" });
    const rows = JSON.parse(out) as {
      st: string;
      cells: {
        column: string;
        text: string;
        lines: CompareLine[];
        rules: { id: string; quote: string; summary: string; source_kind: string | null }[];
      }[];
    }[];
    expect(rows.map((r) => r.st).sort()).toEqual(states);
    for (const row of rows) {
      const { law } = built.get(row.st)!;
      expect(row.cells.map((c) => c.column)).toEqual(COLUMNS.map((c) => c.id));
      for (const cell of row.cells) {
        expect(cell.text.length).toBeGreaterThan(0);
        expect(cell.rules.map((r) => r.id).sort()).toEqual([...new Set(cell.lines.flatMap(lineCites))].sort());
        for (const r of cell.rules) {
          const rule = law.rules.find((x) => x.id === r.id)!;
          expect([r.quote, r.summary]).toEqual([rule.quote, rule.summary]);
          expect(r.source_kind).toBe(law.sources.find((s) => s.id === rule.source_id)!.kind);
        }
      }
    }
  });
});
