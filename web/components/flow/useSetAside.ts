"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchLawIr } from "@/lib/api";
import type { LawIr } from "@/lib/deadline";
import { setAsideIds } from "./checkSummary";

const EMPTY = new Set<string>();

// The state's law IR (public/data/ir, the same IR the engine compiles): undefined while it loads,
// null if it cannot. The offline worker keeps every state's copy.
export function useLawIr(st: string | null | undefined): LawIr | null | undefined {
  const key = (st ?? "").toUpperCase();
  const [loaded, setLoaded] = useState<{ st: string; ir: LawIr | null } | null>(null);

  useEffect(() => {
    if (!/^[A-Z]{2}$/.test(key)) return;
    let live = true;
    fetchLawIr(key).then((ir) => live && setLoaded({ st: key, ir }));
    return () => {
      live = false;
    };
  }, [key]);

  return loaded && loaded.st === key ? loaded.ir : undefined;
}

// The rule ids the law IR sets aside for this state. Until it loads, or if it cannot, nothing is set aside.
export function setAsideOf(ir: LawIr | null | undefined): Set<string> {
  return ir ? setAsideIds(ir) : EMPTY;
}

export function useSetAside(st: string | null | undefined): Set<string> {
  const ir = useLawIr(st);
  return useMemo(() => setAsideOf(ir), [ir]);
}
