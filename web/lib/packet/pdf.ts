// A small flow layout on top of pdf-lib: wrapped runs of text in mixed fonts, tables that break
// across pages, link annotations, and a footer on every page. Standard PDF fonts only (no font
// files to fetch), and no clock or random input, so the same content always gives the same bytes.
import { PDFDocument, PDFHexString, rgb, StandardFonts, type PDFFont, type PDFPage, type RGB } from "pdf-lib";

export const PAGE_W = 612;
export const PAGE_H = 792;
export const MARGIN = 54;
const FOOTER_SPACE = 34;
export const CONTENT_W = PAGE_W - 2 * MARGIN;

// web/DESIGN.md tokens (light theme), for paper.
const hex = (h: string): RGB =>
  rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
export const COLORS = {
  ink: hex("#1C1B18"),
  ink2: hex("#4A463E"),
  ink3: hex("#6A655B"),
  line: hex("#D8D1C3"),
  lineStrong: hex("#857E70"),
  green: hex("#1F5136"),
  greenTint: hex("#E2EADF"),
  clay: hex("#9B4E33"),
  clayTint: hex("#F2E2D8"),
  paperSunk: hex("#ECE6DA"),
};
export type ColorKey = keyof typeof COLORS;

export type FontKey = "sans" | "bold" | "italic" | "serif" | "serifBold" | "mono";
const FONT_FILES: Record<FontKey, StandardFonts> = {
  sans: StandardFonts.Helvetica,
  bold: StandardFonts.HelveticaBold,
  italic: StandardFonts.HelveticaOblique,
  serif: StandardFonts.TimesRoman,
  serifBold: StandardFonts.TimesRomanBold,
  mono: StandardFonts.Courier,
};

export interface Run {
  text: string;
  font?: FontKey;
  color?: ColorKey;
  link?: string | null;
  underline?: boolean;
}

export interface TextStyle {
  size?: number;
  leading?: number;
  font?: FontKey;
  color?: ColorKey;
}

// Characters the standard fonts cannot draw are folded to plain ones (accents dropped,
// unusual dashes to "-") instead of failing the whole document. The law's own curly quotes,
// section signs, and dashes are kept: WinAnsi has them.
const FALLBACK: Record<string, string> = {
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "−": "-",
  "≤": "<=",
  "≥": ">=",
  "′": "'",
  "″": '"',
  "→": "->",
  "←": "<-",
  "✓": "x",
  "✔": "x",
};

export function makeCleaner(charset: Set<number>): (text: string) => string {
  return (text) => {
    let out = "";
    for (const ch of text.normalize("NFC")) {
      const cp = ch.codePointAt(0)!;
      if (cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0xa0 || cp === 0x2007 || cp === 0x202f) {
        out += " ";
      } else if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) {
        continue;
      } else if (charset.has(cp)) {
        out += ch;
      } else if (FALLBACK[ch]) {
        out += FALLBACK[ch];
      } else {
        const folded = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
        out += folded && [...folded].every((c) => charset.has(c.codePointAt(0)!)) ? folded : "?";
      }
    }
    return out;
  };
}

interface Piece {
  text: string;
  font: FontKey;
  color: ColorKey;
  link: string | null;
  underline: boolean;
  width: number;
  space: boolean;
}

export class Pdf {
  readonly pages: PDFPage[] = [];
  page!: PDFPage;
  y = 0;
  // Every paragraph as written (before wrapping), for tests and for checking what a packet says.
  readonly transcript: string[] = [];
  private constructor(
    readonly doc: PDFDocument,
    private readonly fonts: Record<FontKey, PDFFont>,
    readonly clean: (text: string) => string,
  ) {}

  static async create(title: string): Promise<Pdf> {
    // updateMetadata: false keeps pdf-lib from stamping the current time into the file.
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.setTitle(title);
    doc.setProducer("Tend");
    doc.setCreator("Tend");
    const fonts = {} as Record<FontKey, PDFFont>;
    for (const key of Object.keys(FONT_FILES) as FontKey[]) fonts[key] = await doc.embedFont(FONT_FILES[key]);
    const pdf = new Pdf(doc, fonts, makeCleaner(new Set(fonts.sans.getCharacterSet())));
    pdf.newPage();
    return pdf;
  }

  font(key: FontKey): PDFFont {
    return this.fonts[key];
  }

  newPage(): void {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = PAGE_H - MARGIN;
  }

  get bottom(): number {
    return MARGIN + FOOTER_SPACE;
  }

  // Starts a new page unless h points still fit on this one.
  ensure(h: number): void {
    if (this.y - h < this.bottom) this.newPage();
  }

  space(h: number): void {
    this.y -= h;
  }

  width(text: string, font: FontKey, size: number): number {
    return this.fonts[font].widthOfTextAtSize(text, size);
  }

  // Splits runs into words and wraps them to the width. Words longer than a line (ids, links)
  // break between characters.
  wrap(runs: Run[], width: number, size: number, base: Required<Pick<TextStyle, "font" | "color">>): Piece[][] {
    const pieces: Piece[] = [];
    for (const run of runs) {
      const font = run.font ?? base.font;
      const color = run.color ?? base.color;
      const text = this.clean(run.text);
      for (const part of text.split(/( +)/)) {
        if (!part) continue;
        const space = /^ +$/.test(part);
        const make = (t: string): Piece => ({
          text: space ? " " : t,
          font,
          color,
          link: run.link ?? null,
          underline: run.underline ?? !!run.link,
          width: this.width(space ? " " : t, font, size),
          space,
        });
        if (space) {
          pieces.push(make(" "));
          continue;
        }
        let rest = part;
        while (this.width(rest, font, size) > width) {
          let n = rest.length - 1;
          while (n > 1 && this.width(rest.slice(0, n), font, size) > width) n -= 1;
          pieces.push(make(rest.slice(0, n)));
          pieces.push({ ...make(""), text: "", width: 0, space: false, link: run.link ?? null });
          rest = rest.slice(n);
        }
        pieces.push(make(rest));
      }
    }
    const lines: Piece[][] = [];
    let line: Piece[] = [];
    let w = 0;
    const flush = () => {
      while (line.length && line[line.length - 1].space) line.pop();
      lines.push(line);
      line = [];
      w = 0;
    };
    for (const p of pieces) {
      if (p.text === "" && !p.space) {
        // forced break inside a long word
        flush();
        continue;
      }
      if (p.space && line.length === 0) continue;
      if (!p.space && w + p.width > width && line.length) flush();
      line.push(p);
      w += p.width;
    }
    if (line.length) flush();
    return lines.length ? lines : [[]];
  }

  // Draws wrapped runs at x with the given width. Returns the height used.
  runs(runs: Run[], style: TextStyle = {}, x = MARGIN, width = CONTENT_W, record = true): number {
    const size = style.size ?? 9.5;
    const leading = style.leading ?? size * 1.38;
    const base = { font: style.font ?? "sans", color: style.color ?? "ink" } as const;
    if (record) this.transcript.push(runs.map((r) => r.text).join(""));
    const lines = this.wrap(runs, width, size, base);
    const start = this.y;
    for (const line of lines) {
      this.ensure(leading);
      const baseline = this.y - size * 0.92;
      this.drawLine(line, x, baseline, size);
      this.y -= leading;
    }
    return start - this.y;
  }

  text(text: string, style: TextStyle = {}, x = MARGIN, width = CONTENT_W): number {
    return this.runs([{ text }], style, x, width);
  }

  // Lays out lines without drawing, for measuring table rows.
  measure(runs: Run[], style: TextStyle, width: number): number {
    const size = style.size ?? 9.5;
    const leading = style.leading ?? size * 1.38;
    return this.wrap(runs, width, size, { font: style.font ?? "sans", color: style.color ?? "ink" }).length * leading;
  }

  private drawLine(line: Piece[], x: number, baseline: number, size: number): void {
    let cx = x;
    let i = 0;
    while (i < line.length) {
      // Merge neighbors with the same look into one text run.
      let j = i;
      let text = "";
      let w = 0;
      while (
        j < line.length &&
        line[j].font === line[i].font &&
        line[j].color === line[i].color &&
        line[j].link === line[i].link &&
        line[j].underline === line[i].underline
      ) {
        text += line[j].text;
        w += line[j].width;
        j += 1;
      }
      const p = line[i];
      if (text) {
        this.page.drawText(text, { x: cx, y: baseline, size, font: this.fonts[p.font], color: COLORS[p.color] });
        const trimmed = text.replace(/ +$/, "");
        const tw = this.width(trimmed, p.font, size);
        if (p.underline && tw > 0) {
          this.page.drawLine({
            start: { x: cx, y: baseline - 1.2 },
            end: { x: cx + tw, y: baseline - 1.2 },
            thickness: 0.5,
            color: COLORS[p.color],
          });
        }
        if (p.link && tw > 0) this.link(cx, baseline - 2.5, tw, size + 2.5, p.link);
      }
      cx += w;
      i = j;
    }
  }

  link(x: number, y: number, w: number, h: number, url: string): void {
    const ctx = this.doc.context;
    // A URI is 7-bit ASCII. Written as a hex string, a stray parenthesis or backslash in a link
    // cannot break the file (pdf-lib writes literal strings without escaping).
    const ascii = url.replace(/[^\x20-\x7e]/g, (c) => encodeURIComponent(c));
    const hex = Array.from(ascii, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    const annot = ctx.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [x, y, x + w, y + h],
      Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFHexString.of(hex) },
    });
    this.page.node.addAnnot(ctx.register(annot));
  }

  rule(color: ColorKey = "line", thickness = 0.6, x = MARGIN, width = CONTENT_W): void {
    this.page.drawLine({ start: { x, y: this.y }, end: { x: x + width, y: this.y }, thickness, color: COLORS[color] });
  }

  rect(x: number, y: number, w: number, h: number, fill: ColorKey, border?: ColorKey): void {
    this.page.drawRectangle({
      x,
      y,
      width: w,
      height: h,
      color: COLORS[fill],
      borderColor: border ? COLORS[border] : undefined,
      borderWidth: border ? 0.8 : 0,
    });
  }

  // An empty or ticked box drawn as lines, so no symbol font is needed.
  checkbox(x: number, top: number, size: number, checked: boolean): void {
    this.page.drawRectangle({
      x,
      y: top - size,
      width: size,
      height: size,
      borderColor: COLORS.ink,
      borderWidth: 0.8,
    });
    if (checked) {
      const s = size;
      this.page.drawLine({
        start: { x: x + s * 0.2, y: top - s * 0.55 },
        end: { x: x + s * 0.42, y: top - s * 0.8 },
        thickness: 1.2,
        color: COLORS.green,
      });
      this.page.drawLine({
        start: { x: x + s * 0.42, y: top - s * 0.8 },
        end: { x: x + s * 0.82, y: top - s * 0.18 },
        thickness: 1.2,
        color: COLORS.green,
      });
    }
  }

  // Footer and running header, once the page count is known.
  finish(opts: { footer: string; header?: string }): void {
    const n = this.pages.length;
    this.pages.forEach((page, i) => {
      const size = 7.5;
      const font = this.fonts.sans;
      const y = MARGIN - 14;
      page.drawLine({
        start: { x: MARGIN, y: y + 12 },
        end: { x: PAGE_W - MARGIN, y: y + 12 },
        thickness: 0.5,
        color: COLORS.line,
      });
      page.drawText(this.clean(opts.footer), { x: MARGIN, y, size, font, color: COLORS.ink3 });
      const label = `Page ${i + 1} of ${n}`;
      page.drawText(label, {
        x: PAGE_W - MARGIN - font.widthOfTextAtSize(label, size),
        y,
        size,
        font,
        color: COLORS.ink3,
      });
      if (opts.header && i > 0) {
        page.drawText(this.clean(opts.header), { x: MARGIN, y: PAGE_H - MARGIN + 16, size, font, color: COLORS.ink3 });
      }
    });
  }

  async save(): Promise<Uint8Array> {
    return this.doc.save({ useObjectStreams: false });
  }
}
