// PDF text on the device with pdf.js, rebuilt into lines in reading order. Columns more than a
// glyph or so apart are joined with two spaces, the way a layout text dump separates them.
type Pdfjs = typeof import("pdfjs-dist");

export interface PdfSegment {
  text: string;
  x: number;
  x2: number;
}

export interface PdfLine {
  page: number;
  y: number;
  text: string;
  segments: PdfSegment[];
}

let loading: Promise<Pdfjs> | null = null;

// pdf.js parses on this thread through its "fake worker", which works with any bundler and needs
// no worker file served from public/. Statements and bills are a few pages, so this is quick.
async function loadPdfjs(): Promise<Pdfjs> {
  const g = globalThis as { pdfjsWorker?: unknown };
  if (typeof window === "undefined") {
    // Node (tests, scripts): the modern build needs browser-only APIs, so use the legacy one.
    const [lib, worker] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ]);
    g.pdfjsWorker ??= worker;
    return lib as unknown as Pdfjs;
  }
  const [lib, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.mjs")]);
  g.pdfjsWorker ??= worker;
  return lib;
}

export function pdfjs(): Promise<Pdfjs> {
  loading ??= loadPdfjs().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

export function isPdf(bytes: Uint8Array): boolean {
  // "%PDF" may follow a little junk; readers accept it within the first kilobyte.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

interface RawItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

export async function openPdf(bytes: Uint8Array) {
  const lib = await pdfjs();
  // pdf.js may take ownership of the buffer, so it gets a copy.
  return lib.getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
}

export async function pdfLines(bytes: Uint8Array, maxPages = 20): Promise<{ lines: PdfLine[]; pages: number }> {
  const doc = await openPdf(bytes);
  const lines: PdfLine[] = [];
  try {
    const pages = Math.min(doc.numPages, maxPages);
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const items = (content.items as unknown[]).filter(
        (i): i is RawItem => typeof (i as RawItem).str === "string" && Array.isArray((i as RawItem).transform),
      );
      lines.push(...groupLines(items, p));
      page.cleanup();
    }
    return { lines, pages: doc.numPages };
  } finally {
    await doc.loadingTask.destroy();
  }
}

export function groupLines(items: RawItem[], page: number): PdfLine[] {
  const glyphs = items
    .filter((i) => i.str.trim() !== "")
    // Rotated text is a watermark or a margin note, not a statement row.
    .filter(
      (i) =>
        Math.abs(i.transform[1]) < 0.01 * Math.abs(i.transform[0] || 1) &&
        Math.abs(i.transform[2]) < 0.01 * Math.abs(i.transform[3] || 1),
    )
    .map((i) => {
      const size = Math.abs(i.transform[3]) || i.height || 10;
      return { text: i.str, x: i.transform[4], x2: i.transform[4] + i.width, y: i.transform[5], size };
    })
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: (typeof glyphs)[] = [];
  for (const g of glyphs) {
    const row = rows.find((r) => Math.abs(r[0].y - g.y) <= Math.max(2, 0.3 * Math.min(r[0].size, g.size)));
    if (row) row.push(g);
    else rows.push([g]);
  }
  return rows
    .map((row) => {
      row.sort((a, b) => a.x - b.x);
      let text = "";
      let prev: (typeof row)[number] | null = null;
      for (const g of row) {
        if (prev) {
          const gap = g.x - prev.x2;
          const size = Math.min(prev.size, g.size);
          if (gap > Math.max(3, 0.8 * size)) text = text.replace(/ +$/, "") + "  ";
          else if (gap > 0.12 * size && !text.endsWith(" ") && !g.text.startsWith(" ")) text += " ";
        }
        text += g.text;
        prev = g;
      }
      const segments: PdfSegment[] = row.map((g) => ({ text: g.text, x: g.x, x2: g.x2 }));
      return { page, y: row[0].y, text: text.trim(), segments };
    })
    .sort((a, b) => b.y - a.y);
}

// Plain text, one line per row, for the line parsers.
export function linesToText(lines: PdfLine[]): string {
  return lines.map((l) => l.text).join("\n");
}
