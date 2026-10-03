// The verified rules for one jurisdiction, indexed for the packet. Rules come from
// public/data/law/ST.json (a byte copy of rules/verified/ST.json) or from the API's
// GET /api/jurisdictions/{st}; both are the same file.
import type { Jurisdiction, Rule, Source } from "../types";

export type LawLoader = (st: string) => Promise<Jurisdiction>;

export class LawNotFoundError extends Error {
  constructor(st: string) {
    super(`Tend has no verified rules for ${st}.`);
    this.name = "LawNotFoundError";
  }
}

const isLaw = (v: unknown, st: string): v is Jurisdiction => {
  const law = v as Jurisdiction | null;
  return !!law && law.jurisdiction === st && Array.isArray(law.rules) && Array.isArray(law.sources) && !!law.program;
};

// With the API connected (next.config.ts sets NEXT_PUBLIC_TEND_API), its copy comes first: it reads
// rules/verified directly, so it is never older than the copy synced into public/data.
export function fetchLawLoader(
  fetchImpl: () => typeof fetch = () => globalThis.fetch,
  apiFirst: boolean = process.env.NEXT_PUBLIC_TEND_API === "1",
): LawLoader {
  const cache = new Map<string, Promise<Jurisdiction>>();
  async function load(st: string): Promise<Jurisdiction> {
    const urls = [`/data/law/${st}.json`, `/api/jurisdictions/${st}`];
    if (apiFirst) urls.reverse();
    for (const url of urls) {
      try {
        const res = await fetchImpl()(url, { headers: { accept: "application/json" } });
        if (!res.ok) continue;
        const body: unknown = await res.json();
        if (isLaw(body, st)) return body;
      } catch {
        // try the next copy
      }
    }
    throw new LawNotFoundError(st);
  }
  return (st) => {
    const key = st.toUpperCase();
    let pending = cache.get(key);
    if (!pending) {
      pending = load(key);
      cache.set(key, pending);
      pending.catch(() => cache.delete(key));
    }
    return pending;
  };
}

// Categories added to the corpus after lib/types.ts was written.
export type AnyCategory = Rule["category"] | "address_confidentiality" | "record_confidentiality";

export class LawBook {
  private readonly rules: Map<string, Rule>;
  private readonly sources: Map<string, Source>;

  constructor(readonly law: Jurisdiction) {
    this.rules = new Map(law.rules.map((r) => [r.id, r]));
    this.sources = new Map(law.sources.map((s) => [s.id, s]));
  }

  get st(): string {
    return this.law.jurisdiction;
  }

  get name(): string {
    return this.law.name;
  }

  rule(id: string): Rule | undefined {
    return this.rules.get(id);
  }

  source(id: string): Source | undefined {
    return this.sources.get(id);
  }

  byCategory(category: AnyCategory): Rule[] {
    return this.law.rules.filter((r) => (r.category as string) === category);
  }

  // The official page, opened at the quoted sentence when the corpus has a text fragment link.
  link(rule: Rule): string | null {
    return rule.fragment_url || this.source(rule.source_id)?.url || null;
  }

  // The page itself, for print: a text fragment link is long and means nothing on paper.
  printedLink(rule: Rule): string | null {
    const url = this.source(rule.source_id)?.url ?? rule.fragment_url ?? null;
    return url ? url.split("#:~:")[0] : null;
  }

  // Sources behind a set of rules, in the corpus's own order.
  sourcesFor(ruleIds: Iterable<string>): Source[] {
    const ids = new Set<string>();
    for (const id of ruleIds) {
      const r = this.rule(id);
      if (r) ids.add(r.source_id);
    }
    return this.law.sources.filter((s) => ids.has(s.id));
  }
}

export function param<T = unknown>(rule: Rule | undefined, key: string): T | undefined {
  return (rule?.params ?? undefined)?.[key] as T | undefined;
}
