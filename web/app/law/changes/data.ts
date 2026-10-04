// What changed between two law versions (docs/NEON.md). Each version is a Neon branch holding every program's
// verified rules at one moment. With TEND_API_URL set, the page asks the API, which reads the two branches; without
// it, or when the API does not answer, it uses the saved comparison in snapshot.json (written from the same branches
// by scripts/neon/law_versions.py snapshot) and says so. Server only.
import SNAPSHOT from "./snapshot.json";

export interface VersionRef {
  name: string;
  seq: number;
  git_sha: string;
  short_sha: string;
  committed_at: string;
  subject: string;
  parent: string | null;
  branch_id: string;
  jurisdictions: number;
  rules: number;
  sources: number;
  current?: boolean;
}

export interface LawRule {
  rule_id: string;
  category: string;
  summary: string;
  quote: string;
  pinpoint: string;
  fragment_url: string | null;
  source_id: string;
  source_title: string | null;
  source_url: string | null;
  source_sha256: string | null;
}

export type ChangeKind = "text" | "meaning" | "engine" | "source_copy";

export interface RuleChange {
  rule_id: string;
  kinds: ChangeKind[];
  fields: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  rule: LawRule;
}

export interface SourceChange {
  source_id: string;
  title: string | null;
  url: string | null;
  kind: string | null;
  sha256: string | null;
  sha256_before?: string | null;
  url_before?: string | null;
}

export interface Counts {
  added: number;
  removed: number;
  changed: number;
  sources_added: number;
  sources_removed: number;
  sources_changed: number;
}

export interface StateDiff {
  from: VersionRef;
  to: VersionRef;
  compared_at?: string;
  st: string;
  unchanged: boolean;
  files_changed: boolean;
  counts: Counts;
  added: LawRule[];
  removed: LawRule[];
  changed: RuleChange[];
  sources: { added: SourceChange[]; removed: SourceChange[]; changed: SourceChange[] };
  state: { field: string; before: unknown; after: unknown }[];
}

export interface SummaryRow extends Counts {
  st: string;
  unchanged: boolean;
  files_changed: boolean;
}

export interface AllStatesDiff {
  from: VersionRef;
  to: VersionRef;
  compared_at?: string;
  states: SummaryRow[];
  changed_states: number;
  files_changed_states: number;
  totals: Counts;
  by_category: { added: Record<string, number>; removed: Record<string, number>; changed: Record<string, number> };
  changed_kinds: Record<string, number>;
}

interface Snapshot {
  saved_at: string;
  current: string | null;
  versions: VersionRef[];
  pairs: Record<string, { summary: AllStatesDiff; states: Record<string, StateDiff> }>;
}

const saved = SNAPSHOT as unknown as Snapshot;

export interface ChangesView {
  source: "live" | "saved";
  savedAt: string | null;
  // When the API compared the two branches (a comparison can be kept for a while, since versions never change).
  comparedAt: string | null;
  versions: VersionRef[];
  current: string | null;
  from: VersionRef;
  to: VersionRef;
  summary: AllStatesDiff | null;
  state: StateDiff | null;
  // The saved copy holds consecutive versions and the first against the newest; other pairs need the live service.
  unavailable: boolean;
  // Plain notes on what each version changed, from the saved comparisons of consecutive versions.
  notes: Record<string, AllStatesDiff>;
}

async function api<T>(path: string): Promise<T | null> {
  const base = process.env.TEND_API_URL?.replace(/\/$/, "");
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(9000),
      // A published version never changes, so a comparison can be kept a while; the list of versions is checked again.
      next: { revalidate: path.startsWith("/law/versions") ? 60 : 3600 },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// The pair to compare: "to" defaults to the newest version and "from" to the one before it. An older "to" is swapped,
// so the page always reads forward in time.
export function pickPair(versions: VersionRef[], from?: string, to?: string): [VersionRef, VersionRef] {
  const byName = new Map(versions.map((v) => [v.name, v]));
  let b = (to && byName.get(to)) || versions[versions.length - 1];
  let a = from ? byName.get(from) : undefined;
  if (!a || a.name === b.name) a = versions.filter((v) => v.seq < b.seq).at(-1) ?? undefined;
  if (!a) [a, b] = [versions[0], versions[1]];
  return a.seq < b.seq ? [a, b] : [b, a];
}

function consecutiveNotes(): Record<string, AllStatesDiff> {
  const notes: Record<string, AllStatesDiff> = {};
  for (const [key, pair] of Object.entries(saved.pairs)) {
    const [, to] = key.split("..");
    if (pair.summary.from.seq + 1 === pair.summary.to.seq) notes[to] = pair.summary;
  }
  return notes;
}

function unchangedState(from: VersionRef, to: VersionRef, st: string): StateDiff {
  const zero: Counts = { added: 0, removed: 0, changed: 0, sources_added: 0, sources_removed: 0, sources_changed: 0 };
  return {
    from,
    to,
    st,
    unchanged: true,
    files_changed: false,
    counts: zero,
    added: [],
    removed: [],
    changed: [],
    sources: { added: [], removed: [], changed: [] },
    state: [],
  };
}

export async function loadChanges(q: { st?: string; from?: string; to?: string }): Promise<ChangesView> {
  const notes = consecutiveNotes();
  const listing = await api<{ versions: VersionRef[]; current: string | null }>("/law/versions");
  if (listing && listing.versions.length >= 2) {
    const [from, to] = pickPair(listing.versions, q.from, q.to);
    const params = new URLSearchParams({ from: from.name, to: to.name, ...(q.st ? { st: q.st } : {}) });
    const diff = await api<StateDiff | AllStatesDiff>(`/law/diff?${params}`);
    if (diff) {
      return {
        source: "live",
        savedAt: null,
        comparedAt: diff.compared_at ?? null,
        versions: listing.versions,
        current: listing.current,
        from,
        to,
        summary: q.st ? null : (diff as AllStatesDiff),
        state: q.st ? (diff as StateDiff) : null,
        unavailable: false,
        notes,
      };
    }
  }
  const [from, to] = pickPair(saved.versions, q.from, q.to);
  const pair = saved.pairs[`${from.name}..${to.name}`];
  const state = q.st && pair ? (pair.states[q.st] ?? unchangedState(from, to, q.st)) : null;
  return {
    source: "saved",
    savedAt: saved.saved_at,
    comparedAt: null,
    versions: saved.versions,
    current: saved.current,
    from,
    to,
    summary: !q.st && pair ? pair.summary : null,
    state,
    unavailable: !pair,
    notes,
  };
}
