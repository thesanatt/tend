"use client";

import { useEffect, useState } from "react";
import { setAsideIds } from "./checkSummary";

const EMPTY = new Set<string>();
const cache = new Map<string, Promise<Set<string>>>();

// The rule ids the law IR sets aside for this state (public/data/ir, the same IR the engine compiles).
// Until it loads, or if it cannot, nothing is set aside.
export function useSetAside(st: string | null | undefined): Set<string> {
  const key = (st ?? "").toUpperCase();
  const [loaded, setLoaded] = useState<{ st: string; ids: Set<string> } | null>(null);

  useEffect(() => {
    if (!/^[A-Z]{2}$/.test(key)) return;
    let live = true;
    let pending = cache.get(key);
    if (!pending) {
      pending = fetch(`/data/ir/${key}.json`)
        .then(async (res) => (res.ok ? setAsideIds(await res.json()) : EMPTY))
        .catch(() => EMPTY);
      cache.set(key, pending);
    }
    pending.then((ids) => live && setLoaded({ st: key, ids }));
    return () => {
      live = false;
    };
  }, [key]);

  return loaded && loaded.st === key ? loaded.ids : EMPTY;
}
