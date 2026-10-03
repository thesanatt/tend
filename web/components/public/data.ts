// Build-time readers for the files scripts/sync-rules.mjs and scripts/build-asm.mjs write to
// public/data. Server components and metadata routes only (they read the file system).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import STATES from "@/lib/states.json";
import type { Jurisdiction, JurisdictionSummary } from "@/lib/types";
import type { Asm, AsmEntry, IrSummary } from "./types";

const DATA = path.join(process.cwd(), "public", "data");

export interface StateRef {
  st: string;
  name: string;
}

// "mi" and "MI" both name Michigan; anything else is not a jurisdiction.
export function stateFromParam(param: string): StateRef | null {
  const st = param.toUpperCase();
  const found = STATES.find((s) => s.st === st);
  return found ? { st: found.st, name: found.name } : null;
}

export function allStates(): StateRef[] {
  return STATES.map(({ st, name }) => ({ st, name })).sort((a, b) => a.name.localeCompare(b.name));
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function loadLaw(st: string): { law: Jurisdiction; sha256: string } | null {
  const file = path.join(DATA, "law", `${st}.json`);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file);
  return { law: JSON.parse(raw.toString("utf8")) as Jurisdiction, sha256: createHash("sha256").update(raw).digest("hex") };
}

export function loadIr(st: string): IrSummary | null {
  return readJson<IrSummary>(path.join(DATA, "ir", `${st}.json`));
}

export function loadAsm(st: string): Asm | null {
  const file = path.join(DATA, "asm", `${st}.txt`);
  if (!existsSync(file)) return null;
  const index = readJson<{ states: Record<string, AsmEntry> }>(path.join(DATA, "asm", "index.json"));
  return { text: readFileSync(file, "utf8"), meta: index?.states?.[st] ?? null };
}

export interface Corpus {
  jurisdictions: JurisdictionSummary[];
  rules: number;
  sources: number;
  programs: number;
  verified: number;
  setAside: number;
}

// Counts for the home page, computed when the site is built.
export function loadCorpus(): Corpus {
  const jurisdictions = readJson<(JurisdictionSummary & { set_aside?: number })[]>(
    path.join(DATA, "jurisdictions.json"),
  ) ?? [];
  return {
    jurisdictions,
    rules: jurisdictions.reduce((n, j) => n + j.rules, 0),
    sources: jurisdictions.reduce((n, j) => n + j.sources, 0),
    programs: jurisdictions.length,
    verified: jurisdictions.filter((j) => j.rules > 0).length,
    setAside: jurisdictions.reduce((n, j) => n + (j.set_aside ?? 0), 0),
  };
}

// Where the share card points. Set NEXT_PUBLIC_SITE_URL when deploying; docs/UX.md names youreowed.tech.
export function siteUrl(): URL {
  const raw = process.env.NEXT_PUBLIC_SITE_URL || "https://youreowed.tech";
  try {
    return new URL(raw);
  } catch {
    return new URL("https://youreowed.tech");
  }
}
