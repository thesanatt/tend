"use client";

import { useEffect, useRef, useState } from "react";

// True for a moment after `value` changes (never on first render), to mark a state change.
export function useJustChanged(value: unknown, ms = 1200): boolean {
  const prev = useRef(value);
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    if (Object.is(prev.current, value)) return;
    prev.current = value;
    setChanged(true);
    const t = window.setTimeout(() => setChanged(false), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);

  return changed;
}
