// Splits a tdis listing line into styled pieces, turning rule ids into links to the rule on the page.

export type SegKind = "comment" | "label" | "dir" | "off";

export interface Seg {
  t: string;
  k?: SegKind;
  // A rule id that exists in this jurisdiction's verified rules.
  id?: string;
}

const RULE_ID = /\b[A-Z]{2}-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;
// "  0068  L0:   push     0"
const INSTRUCTION = /^(\s*)([0-9a-f]{4})(\s+)(L\d+:)?(.*)$/;

function linkify(text: string, k: SegKind | undefined, ids: Set<string>): Seg[] {
  const out: Seg[] = [];
  let last = 0;
  for (const m of text.matchAll(RULE_ID)) {
    if (!ids.has(m[0])) continue;
    if (m.index > last) out.push({ t: text.slice(last, m.index), k });
    out.push({ t: m[0], k, id: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last), k });
  return out;
}

export function asmLine(line: string, ids: Set<string>): Seg[] {
  const trimmed = line.trimStart();
  if (trimmed.startsWith(";")) return linkify(line, "comment", ids);
  const dir = line.match(/^(\.\S+)(.*)$/);
  if (dir) return [{ t: dir[1], k: "dir" }, ...linkify(dir[2], undefined, ids)];
  const at = line.indexOf(";");
  const code = at >= 0 ? line.slice(0, at) : line;
  const comment = at >= 0 ? line.slice(at) : "";
  const out: Seg[] = [];
  const m = code.match(INSTRUCTION);
  if (m) {
    out.push({ t: m[1] }, { t: m[2], k: "off" }, { t: m[3] });
    if (m[4]) out.push({ t: m[4], k: "label" });
    out.push(...linkify(m[5], undefined, ids));
  } else {
    out.push(...linkify(code, undefined, ids));
  }
  if (comment) out.push(...linkify(comment, "comment", ids));
  // Merge plain neighbors so the page carries fewer nodes.
  const merged: Seg[] = [];
  for (const s of out) {
    const prev = merged.at(-1);
    if (s.t === "") continue;
    if (prev && !prev.id && !s.id && prev.k === s.k) prev.t += s.t;
    else merged.push({ ...s });
  }
  return merged;
}

// ".item" -> "asm-item", so the page can link to each part of the listing.
export function directiveAnchor(seg: Seg): string | null {
  return seg.k === "dir" && /^\.[a-z]+$/.test(seg.t) ? `asm-${seg.t.slice(1)}` : null;
}

export interface AsmHeader {
  title: string | null;
  format: string | null;
  compiler: string | null;
  rules_sha256: string | null;
  image_sha256: string | null;
  counts: string | null;
  programs: string[];
}

// The comment block at the top of a listing.
export function asmHeader(text: string): AsmHeader {
  const head: AsmHeader = {
    title: null,
    format: null,
    compiler: null,
    rules_sha256: null,
    image_sha256: null,
    counts: null,
    programs: [],
  };
  for (const raw of text.split("\n").slice(0, 12)) {
    if (!raw.startsWith(";")) break;
    const line = raw.slice(1).trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^tend law image (.+)$/))) head.title = m[1];
    else if ((m = line.match(/^format ([\d.]+), compiled by (.+)$/))) {
      head.format = m[1];
      head.compiler = m[2];
    } else if ((m = line.match(/^source sha256\s+([0-9a-f]{64})$/))) head.rules_sha256 = m[1];
    else if ((m = line.match(/^image sha256\s+([0-9a-f]{64})$/))) head.image_sha256 = m[1];
    else if (/^\d+ rules,/.test(line)) head.counts = line;
    else if (/program:/.test(line)) head.programs.push(line);
  }
  return head;
}
