"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchLaw } from "./api";
import type { Jurisdiction, Rule, Source } from "./types";

export interface LawIndex {
  law: Jurisdiction | null;
  // The law could not be had (offline before it was saved, say). A null law without this is still loading.
  missing?: boolean;
  sha256: string | null;
  rule: (id: string) => Rule | undefined;
  source: (id: string) => Source | undefined;
  byCategory: (category: string) => Rule[];
}

export function useLaw(st: string | null | undefined): LawIndex {
  const [loaded, setLoaded] = useState<{ st: string; law: Jurisdiction | null; sha256: string | null } | null>(null);

  useEffect(() => {
    if (!st) return;
    let live = true;
    fetchLaw(st).then((r) => {
      if (live) setLoaded(r ? { st: st.toUpperCase(), ...r } : { st: st.toUpperCase(), law: null, sha256: null });
    });
    return () => {
      live = false;
    };
  }, [st]);

  return useMemo(() => {
    const current = loaded && st && loaded.st === st.toUpperCase() ? loaded : null;
    const rules = new Map(current?.law?.rules.map((r) => [r.id, r]));
    const sources = new Map(current?.law?.sources.map((s) => [s.id, s]));
    return {
      law: current?.law ?? null,
      missing: current !== null && current.law === null,
      sha256: current?.sha256 ?? null,
      rule: (id) => rules.get(id),
      source: (id) => sources.get(id),
      byCategory: (c) => current?.law?.rules.filter((r) => r.category === c) ?? [],
    };
  }, [loaded, st]);
}
