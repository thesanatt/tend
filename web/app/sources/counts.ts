// The counts /sources and How it works print about Tend's own rules, read from public/data when the site is built,
// so a page and the state pages cannot drift apart when the rules change.
import { loadIr, loadLaw } from "@/components/public/data";
import STATES from "@/lib/states.json";
import type { Jurisdiction } from "@/lib/types";

interface StateLaw {
  st: string;
  name: string;
  law: Jurisdiction;
}

function corpus(): StateLaw[] {
  return STATES.flatMap(({ st, name }) => {
    const loaded = loadLaw(st);
    return loaded ? [{ st, name, law: loaded.law }] : [];
  });
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

export interface ExamCount {
  // Where the law engine applies at least one rule against billing the survivor for the exam.
  counted: string[];
  // set_aside: every such rule is set aside. none: Tend has no such rule.
  missing: { st: string; name: string; why: "set_aside" | "none"; rules: string[] }[];
}

export function examNoBill(): ExamCount {
  const counted: string[] = [];
  const missing: ExamCount["missing"] = [];
  for (const { st, name, law } of corpus()) {
    const rules = law.rules.filter((r) => r.category === "exam_no_bill").map((r) => r.id);
    const applied = new Set((loadIr(st)?.rules ?? []).filter((r) => r.kind === "exam_no_bill").map((r) => r.id));
    if (rules.some((id) => applied.has(id))) counted.push(st);
    else if (!rules.length) missing.push({ st, name, why: "none", rules });
    else missing.push({ st, name, why: "set_aside", rules });
  }
  return { counted, missing: missing.sort(byName) };
}

export interface AddressCount {
  counted: string[];
  // A program Tend found, but not one open to sexual assault survivors as such.
  narrow: { st: string; name: string }[];
  none: { st: string; name: string }[];
}

export function addressPrograms(): AddressCount {
  const out: AddressCount = { counted: [], narrow: [], none: [] };
  for (const { st, name, law } of corpus()) {
    const rules = law.rules.filter((r) => r.category === "address_confidentiality");
    if (rules.some((r) => r.params?.covers_sexual_assault === true)) out.counted.push(st);
    else if (rules.length) out.narrow.push({ st, name });
    else out.none.push({ st, name });
  }
  out.narrow.sort(byName);
  out.none.sort(byName);
  return out;
}

// Sites that reprint state law. A saved copy from one of them is not the state's own publication.
export const REPUBLISHERS = { "law.justia.com": "Justia", "www.law.cornell.edu": "Cornell" } as const;

// "Justia" or "Cornell" for a copy saved from one of them, else null.
export function republisher(url: string): (typeof REPUBLISHERS)[keyof typeof REPUBLISHERS] | null {
  return REPUBLISHERS[host(url) as keyof typeof REPUBLISHERS] ?? null;
}

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export interface Republished {
  justia: number;
  cornell: number;
  sources: number;
  rules: number;
}

export function republished(): Republished {
  const out: Republished = { justia: 0, cornell: 0, sources: 0, rules: 0 };
  for (const { law } of corpus()) {
    const copies = new Set<string>();
    for (const s of law.sources) {
      const who = republisher(s.url);
      if (!who) continue;
      copies.add(s.id);
      if (who === "Justia") out.justia += 1;
      else out.cornell += 1;
    }
    if (!copies.size) continue;
    out.sources += copies.size;
    out.rules += law.rules.filter((r) => copies.has(r.source_id)).length;
  }
  return out;
}

// "Alabama, North Dakota, and Wyoming"
export function names(words: string[]): string {
  if (words.length < 3) return words.join(" and ");
  return `${words.slice(0, -1).join(", ")}, and ${words.at(-1)}`;
}
