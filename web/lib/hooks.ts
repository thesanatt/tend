"use client";

import { useEffect, useRef, useState } from "react";

const UNSET = Symbol("unset");

// True for a moment after `value` changes, to mark a state change. The first settled value never
// counts, so nothing animates on page load; values seen while `settled` is false are ignored.
export function useJustChanged(value: unknown, settled = true, ms = 1200): boolean {
  const prev = useRef<unknown>(UNSET);
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    if (!settled) return;
    if (prev.current === UNSET) {
      prev.current = value;
      return;
    }
    if (Object.is(prev.current, value)) return;
    prev.current = value;
    setChanged(true);
    const t = window.setTimeout(() => setChanged(false), ms);
    return () => window.clearTimeout(t);
  }, [value, settled, ms]);

  return changed;
}
