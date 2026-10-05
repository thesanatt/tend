"use client";

// Tour mode for this tab: one flag in sessionStorage, which Exit this page also clears. Started by a
// link with tour=1 (TOUR_START). Nothing is sent anywhere.
import { useSyncExternalStore } from "react";
import { TOUR_KEY } from "@/lib/keys";
import { tourInUrl } from "./tour";

// Storage can be blocked (private windows, strict settings); the tour then lasts until a reload.
let memory = false;
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return window.sessionStorage.getItem(TOUR_KEY) === "1";
  } catch {
    return memory;
  }
}

function write(on: boolean) {
  memory = on;
  try {
    if (on) window.sessionStorage.setItem(TOUR_KEY, "1");
    else window.sessionStorage.removeItem(TOUR_KEY);
  } catch {
    // blocked storage: the in-memory flag above still works for this page
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// A link with tour=1 turns the tour on for this tab.
export function startTourFromUrl() {
  if (typeof window !== "undefined" && tourInUrl(window.location.search) && !read()) write(true);
}

export function exitTour() {
  write(false);
  // Drop tour=1 from the address too, so a reload does not start the tour again.
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has("tour")) {
      url.searchParams.delete("tour");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
  } catch {
    // the address stays as it was; the flag is already off
  }
}

// Off on the server and during hydration, so the first paint matches; on once this tab says so.
export function useTourMode(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
