// The one-page fact sheet, public/press/tend-fact-sheet.pdf, laid out from app/press/facts.ts with the
// packet's PDF layout (lib/packet/pdf.ts): standard fonts and no clock, so the same facts always give the
// same bytes. scripts/press-factsheet.ts writes the file; tests/press-factsheet.test.ts builds it again
// and compares. Scripts and tests only: it reads the logo from public/press.
import { readFileSync } from "node:fs";
import { longDate } from "@/components/public/format";
import { siteUrl } from "@/components/public/site";
import { COLORS, PAGE_H, PAGE_W, Pdf, type Run, type TextStyle } from "@/lib/packet/pdf";
import { pressFacts, type PressFacts, type PressSource } from "./facts";
import { pressFile } from "./files";

// Tighter margins than the packet's, so every fact fits one letter page.
const SIDE = 40;
const TOP = 36;
const BOTTOM = 72;
const WIDTH = PAGE_W - 2 * SIDE;
const GUTTER = 20;
const COLUMN = (WIDTH - GUTTER) / 2;

const ABOUT: TextStyle = { size: 9.6, leading: 12.9 };
const BODY: TextStyle = { size: 8.6, leading: 11.6 };
const SMALL: TextStyle = { size: 7.4, leading: 9.8, color: "ink3" };
const ROW: TextStyle = { size: 8.4, leading: 11 };
const LINE: TextStyle = { size: 8.6, leading: 12 };
// The links a printed page needs; /press has the rest.
const LINKS_SHOWN = ["Live site", "Fictional demo", "Code on GitHub"];

// Links on this site become full addresses, since a PDF has no site to be relative to.
export function absolute(href: string): string {
  return href.startsWith("/") ? new URL(href, siteUrl()).toString() : href;
}

// "youreowed.tech/press" or "github.com/thesanatt/tend", for print.
export function shown(href: string): string {
  return absolute(href)
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

function sourceRuns(sources: PressSource[]): Run[] {
  const runs: Run[] = [{ text: sources.length > 1 ? "Sources: " : "Source: " }];
  sources.forEach((s, i) => {
    if (i) runs.push({ text: "; " });
    runs.push({ text: s.label, link: absolute(s.href), color: "green" });
  });
  return runs;
}

// Cells two to a row, each row as tall as its taller cell.
function pairs(pdf: Pdf, cells: ((x: number) => void)[], gap: number): void {
  for (let i = 0; i < cells.length; i += 2) {
    const y0 = pdf.y;
    let low = y0;
    cells.slice(i, i + 2).forEach((draw, j) => {
      pdf.y = y0;
      draw(SIDE + j * (COLUMN + GUTTER));
      low = Math.min(low, pdf.y);
    });
    pdf.y = low - gap;
  }
}

export interface FactSheet {
  bytes: Uint8Array;
  // Every paragraph as written, for tests.
  transcript: string[];
  // Points left above the bottom margin, so a test can keep room for what Sanat has yet to add.
  room: number;
}

export async function buildFactSheet(kit: PressFacts = pressFacts()): Promise<FactSheet> {
  const pdf = await Pdf.create("Tend fact sheet");
  pdf.doc.setAuthor("Sanat Gupta");
  pdf.doc.setSubject("Facts about Tend, each with its source. The same facts are on youreowed.tech/press.");
  pdf.doc.setLanguage("en-US");
  // The packet's layout starts a new page 88 points from the bottom. This sheet sets its own footer lower,
  // so text may run down to BOTTOM; a second page means the facts no longer fit, which is an error below.
  Object.defineProperty(pdf, "bottom", { get: () => BOTTOM });
  const press = absolute("/press");

  // Header: the logo on the left; what this is and when its facts were checked on the right. The logo
  // file has a margin of 8 of its 56 units, so it moves left by that much to line the sprout up.
  const logo = await pdf.doc.embedPng(readFileSync(pressFile("tend-logo.png")));
  const logoH = 36;
  const top = PAGE_H - TOP;
  pdf.page.drawImage(logo, {
    x: SIDE - (logoH * 8) / 56,
    y: top - logoH,
    width: (logoH * logo.width) / logo.height,
    height: logoH,
  });
  const right = (runs: Run[], y: number, style: TextStyle & { size: number }) => {
    const w = runs.reduce((sum, r) => sum + pdf.width(r.text, r.font ?? style.font ?? "sans", style.size), 0);
    pdf.y = y;
    pdf.runs(runs, { ...style, leading: style.size * 1.3 }, PAGE_W - SIDE - w, w + 1);
  };
  right([{ text: "Fact sheet" }], top + 1, { size: 15, font: "serifBold" });
  right([{ text: `Facts checked ${longDate(kit.checked)}` }], top - 19, { size: 8, color: "ink2" });
  right([{ text: "Every source is linked at " }, { text: shown(press), link: press, color: "green" }], top - 29, {
    size: 8,
    color: "ink2",
  });
  pdf.y = top - logoH - 5;
  pdf.rule("ink", 1.2, SIDE, WIDTH);
  pdf.space(11);

  pdf.text(kit.about, ABOUT, SIDE, WIDTH);
  pdf.space(5);
  pdf.runs(
    [
      { text: `${kit.builder} `, font: "bold" },
      { text: "Source: ", color: "ink3" },
      { text: kit.builderSource.label, link: absolute(kit.builderSource.href), color: "green" },
    ],
    { size: 9, leading: 12.4 },
    SIDE,
    WIDTH,
  );
  if (kit.why) {
    pdf.space(5);
    pdf.runs(
      [
        { text: "In Sanat Gupta's words: ", font: "bold" },
        { text: `"${kit.why}"`, font: "serif" },
      ],
      { size: 9.6, leading: 12.8 },
      SIDE,
      WIDTH,
    );
  }
  pdf.space(13);

  // Key facts, two to a row, each with its sources under it.
  pdf.runs([{ text: "Key facts" }], { size: 12.5, leading: 15, font: "serifBold" }, SIDE, WIDTH);
  pdf.space(3);
  pdf.rule("ink", 0.8, SIDE, WIDTH);
  pdf.space(7);
  pairs(
    pdf,
    kit.facts.map((fact) => (x: number) => {
      pdf.runs([{ text: fact.text }], BODY, x, COLUMN);
      pdf.space(1.5);
      pdf.runs(sourceRuns(fact.sources), SMALL, x, COLUMN);
    }),
    7,
  );
  pdf.space(5);

  // What's real and what's demo, in a box, each label beside its text.
  const PAD = 10;
  const LABEL = 60;
  const textW = WIDTH - 2 * PAD - LABEL;
  const heights = kit.real.map((r) => pdf.measure([{ text: r.text }], ROW, textW));
  const boxH = 2 * PAD + 14 + 5 + heights.reduce((a, b) => a + b, 0) + 3 * (kit.real.length - 1);
  pdf.rect(SIDE, pdf.y - boxH, WIDTH, boxH, "paperSunk");
  pdf.space(PAD);
  pdf.runs(
    [{ text: "What's real and what's demo" }],
    { size: 11, leading: 14, font: "serifBold" },
    SIDE + PAD,
    WIDTH - 2 * PAD,
  );
  pdf.space(5);
  kit.real.forEach((r, i) => {
    const y0 = pdf.y;
    pdf.runs([{ text: r.label }], { ...ROW, font: "bold" }, SIDE + PAD, LABEL);
    pdf.y = y0;
    pdf.runs([{ text: r.text }], ROW, SIDE + PAD + LABEL, textW);
    pdf.y = y0 - heights[i] - (i < kit.real.length - 1 ? 3 : 0);
  });
  pdf.space(PAD + 9);

  // Where to go next and who to write to.
  const link = (label: string, href: string): Run[] => [
    { text: `${label}: `, font: "bold" },
    { text: shown(href), link: absolute(href), color: "green" },
  ];
  const cells: Run[][] = kit.links.filter((l) => LINKS_SHOWN.includes(l.label)).map((l) => link(l.label, l.href));
  if (kit.video) cells.push(link("Video", kit.video));
  cells.push([
    { text: "Contact: ", font: "bold" },
    kit.contact ? { text: kit.contact, link: `mailto:${kit.contact}`, color: "green" } : { text: "not chosen yet." },
  ]);
  pairs(
    pdf,
    cells.map((cell) => (x: number) => pdf.runs(cell, LINE, x, COLUMN)),
    0,
  );

  if (pdf.pages.length !== 1) {
    throw new Error(`The fact sheet takes ${pdf.pages.length} pages. Shorten a fact, or the paragraph about Tend.`);
  }
  const room = pdf.y - BOTTOM;

  // The footer, below the bottom margin, drawn straight on the page so the layout cannot break it off.
  pdf.page.drawLine({
    start: { x: SIDE, y: 56 },
    end: { x: PAGE_W - SIDE, y: 56 },
    thickness: 0.5,
    color: COLORS.line,
  });
  pdf.page.drawText(pdf.clean(kit.notAdvice), {
    x: SIDE,
    y: 43,
    size: 7.8,
    font: pdf.font("sans"),
    color: COLORS.ink2,
  });
  pdf.transcript.push(kit.notAdvice);

  return { bytes: await pdf.save(), transcript: pdf.transcript, room };
}
