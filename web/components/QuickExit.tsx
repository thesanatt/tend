"use client";

import { useEffect, useRef } from "react";
import styles from "./QuickExit.module.css";

export const EXIT_URL = process.env.NEXT_PUBLIC_EXIT_URL || "https://www.google.com/search?q=weather";
export const DOUBLE_PRESS_MS = 1000;

// Swappable in tests: jsdom does not allow spying on location.replace.
export const navigation = { replace: (url: string) => window.location.replace(url) };

export function leaveNow() {
  // Hide everything first so nothing lingers on screen while the next page loads.
  document.documentElement.dataset.exiting = "true";
  document.title = "Weather";
  try {
    sessionStorage.clear();
  } catch {
    // storage can be blocked; leaving still works
  }
  // replace() swaps this history entry, so Back does not return here.
  navigation.replace(EXIT_URL);
}

// Also rendered inside sheets: a modal dialog makes the corner button unreachable.
export function ExitButton({ className }: { className?: string }) {
  return (
    <button type="button" className={`${styles.exit} ${className ?? ""}`} onClick={leaveNow}>
      Exit this page
    </button>
  );
}

export default function QuickExit() {
  const lastEsc = useRef(-Infinity);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.repeat) return;
      const now = performance.now();
      if (now - lastEsc.current < DOUBLE_PRESS_MS) leaveNow();
      else lastEsc.current = now;
    };
    // Capture phase, so an open dialog cannot swallow the second press.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className={`${styles.wrap} no-print`}>
      <ExitButton />
      <span className={styles.hint} aria-hidden="true">
        or press <kbd>Esc</kbd> twice
      </span>
    </div>
  );
}
