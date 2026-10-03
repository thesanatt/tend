"use client";

import { useEffect, useRef } from "react";
import { LEFT_KEY } from "@/lib/keys";
import styles from "./QuickExit.module.css";

export const EXIT_URL = process.env.NEXT_PUBLIC_EXIT_URL || "https://www.google.com/search?q=weather";
export const DOUBLE_PRESS_MS = 1000;

// Swappable in tests: jsdom does not allow spying on location.replace or reload.
export const navigation = {
  replace: (url: string) => window.location.replace(url),
  reload: () => window.location.reload(),
};

export function leaveNow() {
  // Hide everything first so nothing lingers on screen while the next page loads.
  document.documentElement.dataset.exiting = "true";
  document.title = "Weather";
  try {
    sessionStorage.clear();
    sessionStorage.setItem(LEFT_KEY, "1");
  } catch {
    // storage can be blocked; leaving still works
  }
  // replace() swaps this history entry, so Back does not return here.
  navigation.replace(EXIT_URL);
}

// Back can restore an earlier Tend page from the browser's page cache with its old screen.
// If the person left from this tab, blank that page and load it fresh, which shows nothing personal.
export function onPageShow(e: PageTransitionEvent) {
  if (!e.persisted) return;
  let left = false;
  try {
    left = sessionStorage.getItem(LEFT_KEY) === "1";
  } catch {
    left = true;
  }
  if (!left) return;
  document.documentElement.dataset.exiting = "true";
  navigation.reload();
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
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pageshow", onPageShow);
    };
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
