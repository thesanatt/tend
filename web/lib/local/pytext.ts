// Text helpers that behave like Python's, so rules ported from api/tend_api match the same text.
// Python's re treats \b, \w and \s as Unicode-aware for str patterns; JavaScript's do not, so
// pyRegex rewrites those escapes before compiling.

// Characters str.isspace() accepts (and Python's \s matches). JavaScript's \s differs: it has
// U+FEFF and lacks U+001C to U+001F and U+0085.
const SPACE_CHARS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WORD_CHARS = "\\p{L}\\p{N}_";
const WORD = `[${WORD_CHARS}]`;
const BOUNDARY = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;

export const PY_SPACE = new RegExp(`[${SPACE_CHARS}]`, "u");
const SPACE_RUN = new RegExp(`[${SPACE_CHARS}]+`, "gu");
const LEADING_SPACE = new RegExp(`^[${SPACE_CHARS}]+`, "u");
const TRAILING_SPACE = new RegExp(`[${SPACE_CHARS}]+$`, "u");

// Compiles a Python regex source with Python's Unicode meaning of \b, \w, \W, \s and \S.
export function pyRegex(source: string, flags = "i"): RegExp {
  let out = "";
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\" && i + 1 < source.length) {
      const n = source[i + 1];
      i++;
      if (n === "w") out += inClass ? WORD_CHARS : WORD;
      else if (n === "s") out += inClass ? SPACE_CHARS : `[${SPACE_CHARS}]`;
      else if (n === "W" && !inClass) out += `[^${WORD_CHARS}]`;
      else if (n === "S" && !inClass) out += `[^${SPACE_CHARS}]`;
      else if (n === "b" && !inClass) out += BOUNDARY;
      else out += c + n;
      continue;
    }
    if (c === "[" && !inClass) inClass = true;
    else if (c === "]" && inClass) inClass = false;
    out += c;
  }
  return new RegExp(out, flags.includes("u") ? flags : flags + "u");
}

// str.strip() with no argument.
export function pyStrip(text: string): string {
  return text.replace(LEADING_SPACE, "").replace(TRAILING_SPACE, "");
}

// str.strip(chars): removes any of chars from both ends.
export function pyStripChars(text: string, chars: string): string {
  const set = new Set(Array.from(chars));
  const cps = Array.from(text);
  let a = 0;
  let b = cps.length;
  while (a < b && set.has(cps[a])) a++;
  while (b > a && set.has(cps[b - 1])) b--;
  return cps.slice(a, b).join("");
}

// str.split() with no argument: runs of whitespace, no empty parts.
export function pySplit(text: string): string[] {
  return text.split(SPACE_RUN).filter((part) => part.length > 0);
}

// re.sub(r"\s+", " ", text)
export function collapseSpaces(text: string): string {
  return text.replace(SPACE_RUN, " ");
}

// s[0].upper() + s[1:], by code point.
export function capitalizeFirst(text: string): string {
  const cps = Array.from(text);
  if (!cps.length) return text;
  return cps[0].toUpperCase() + cps.slice(1).join("");
}
