// English and Spanish dictionaries (lib/i18n): same shape, every string present, the copy rules
// hold, and the English reads around grade 6 to 8.
import { describe, expect, it } from "vitest";
import { DICTS, formatters } from "@/lib/i18n";
import { describeSpan, formatDate } from "@/lib/i18n/format";

type Tree = Record<string, unknown>;

// Every leaf as text: functions are called with sample arguments of the right kind.
function leaves(node: unknown, at = ""): [string, string][] {
  if (typeof node === "string") return [[at, node]];
  if (typeof node === "function") {
    const args =
      at === "countLimit" ? ["session", 3] : Array.from({ length: node.length }, (_, i) => (i % 2 ? 3 : "X"));
    const out = (node as (...a: unknown[]) => unknown)(...args);
    return typeof out === "string" ? [[`${at}()`, out]] : [];
  }
  if (Array.isArray(node)) return node.flatMap((v, i) => leaves(v, `${at}[${i}]`));
  if (node && typeof node === "object")
    return Object.entries(node as Tree).flatMap(([k, v]) => leaves(v, at ? `${at}.${k}` : k));
  return [];
}

function shape(node: unknown): unknown {
  if (typeof node === "function") return `fn/${node.length}`;
  if (Array.isArray(node)) return node.map(shape);
  if (node && typeof node === "object")
    return Object.fromEntries(
      Object.entries(node as Tree)
        .map(([k, v]) => [k, shape(v)])
        .sort(),
    );
  return typeof node;
}

const en = leaves(DICTS.en);
const es = leaves(DICTS.es);
const BANNED = new RegExp(
  `[${[0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d].map((c) => String.fromCharCode(c)).join("")}]`,
);

describe("dictionaries", () => {
  it("Spanish has exactly the keys, arrays, and argument counts English has", () => {
    expect(shape(DICTS.es)).toEqual(shape(DICTS.en));
  });

  it("covers every string: nothing in Spanish is empty", () => {
    expect(es.filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([]);
    // English leaves three notes empty on purpose: they explain English text to Spanish readers.
    expect(en.filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([
      "cite.summaryInEnglish",
      "cite.quoteOriginal",
      "letters.inEnglish",
    ]);
  });

  it("is actually translated, apart from words that are the same in both", () => {
    const enMap = new Map(en);
    const same = es.filter(([k, v]) => enMap.get(k) === v).map(([k]) => k);
    expect(same.sort()).toEqual(["common.no", "shell.helpAfter", "track.plantLabel()"].sort());
  });

  it("follows the copy rules: no em or en dashes, no curly quotes, no exclamation marks", () => {
    for (const [k, v] of [...en, ...es]) {
      expect(BANNED.test(v), k).toBe(false);
      expect(v.includes("!"), k).toBe(false);
    }
  });

  it("never asks what happened, where, or who", () => {
    const asks = /\b(what happened\?|where did it happen\?|who did|describe what)/i;
    expect(en.filter(([, v]) => asks.test(v)).map(([k]) => k)).toEqual([]);
  });

  it("reads around grade 6 to 8 (Flesch-Kincaid, English UI copy)", () => {
    const text = en.map(([, v]) => v).join(" ");
    const sentences = text.split(/[.?:;]+\s/).filter((s) => /[a-z]/i.test(s));
    const words = text.match(/[A-Za-z']+/g) ?? [];
    const syllables = words.reduce((n, w) => {
      const groups = w
        .toLowerCase()
        .replace(/e$/, "")
        .match(/[aeiouy]+/g);
      return n + Math.max(1, groups?.length ?? 1);
    }, 0);
    const grade = 0.39 * (words.length / sentences.length) + 11.8 * (syllables / words.length) - 15.59;
    expect(grade).toBeLessThan(8.5);
  });
});

describe("formatting by language", () => {
  it("writes dates the way each language reads them", () => {
    expect(formatDate("2031-06-14", "en")).toBe("June 14, 2031");
    expect(formatDate("2031-06-14", "es")).toBe("14 de junio de 2031");
  });

  it("joins spans of time naturally", () => {
    expect(describeSpan("2026-10-03", "2031-06-14", "en")).toBe("4 years, 8 months");
    expect(describeSpan("2026-10-03", "2031-06-14", "es")).toBe("4 años y 8 meses");
    expect(describeSpan("2026-10-03", "2026-10-10", "es")).toBe("7 días");
    expect(describeSpan("2026-10-03", "2026-01-01", "en")).toBeNull();
  });

  it("keeps money in integer cents and US format in both languages", () => {
    expect(formatters("es").money(118000)).toBe("$1,180.00");
    expect(formatters("en").moneyShort(4500000)).toBe("$45,000");
    expect(formatters("es").and(["un examen forense", "una orden de protección"])).toBe(
      "un examen forense y una orden de protección",
    );
  });
});
