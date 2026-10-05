"use client";

// The 2-minute tour for visitors (recruiters, engineers, judges). Started from the home page with
// /check?demo=rowan&tour=1, it lasts for this tab only: one flag in sessionStorage, which Exit this
// page also clears. Nothing is sent anywhere. English only: the Spanish UI shows no tour notes.
import { useSyncExternalStore } from "react";
import { TOUR_KEY } from "@/lib/keys";

export type TourStep = "check" | "gather" | "bills" | "packet" | "track";

export const TOUR_STEPS: TourStep[] = ["check", "gather", "bills", "packet", "track"];

// Where the tour starts, and where its last note points.
export const TOUR_START = "/check?demo=rowan&tour=1";
export const TOUR_SUMMARY = "/tour";

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

export function tourInUrl(search: string): boolean {
  return new URLSearchParams(search).get("tour") === "1";
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

export function tourStep(path: string): TourStep | null {
  if (path === "/check") return "check";
  if (path === "/gather/bills" || path.startsWith("/gather/bills/")) return "bills";
  if (path === "/gather") return "gather";
  if (path === "/packet") return "packet";
  if (path === "/track") return "track";
  return null;
}

// Each note: what is happening, why it matters, and exactly what to click next. Button names are
// written between ** so they render in bold and match the screen word for word.
export interface TourNoteCopy {
  title: string;
  what: string;
  why: string;
  next: string;
  // The last note links to the summary.
  link?: { href: string; label: string };
}

export const TOUR_NOTES: Record<TourStep, TourNoteCopy> = {
  check: {
    title: "Check",
    what: "Rowan, a fictional survivor in Michigan, answered four questions: the state, the date, whether there was a forensic exam, and whether it was reported to police. No name and no story.",
    why: "Tend checked Michigan's law, compiled into code that runs in your browser, and every line links to the exact sentence. Click a citation, such as MCL 18.355a(10), to read it.",
    next: "Click **Find my costs**.",
  },
  gather: {
    title: "Gather",
    what: "Click **See the sample statement (PDF)** to see the 5-page bank statement, then **Use a sample statement**. Tend reads all 190 transactions on this device; nothing is uploaded.",
    why: "Proving each cost is the hard part of a claim. Tend finds the costs in records a survivor already has, and each one shows the law that covers it. Guesses wait for a yes.",
    next: "Open **Add another record** and click **Use a sample bill**, then **Use the demo bank account**. Then click **Next: your bill**.",
  },
  bills: {
    title: "Bills",
    what: "Line 2 is a $325 forensic exam. Michigan law says hospitals can't bill the survivor for it, so Tend holds it and writes the letter. Pay the other $118 through Capital One's Nessie test bank with the 6-digit code.",
    why: "A bill like this is easy to pay by mistake. Here the held line can't be paid at all, and nothing moves until the code is typed. The money is mock money.",
    next: "Click **Pay $118.00 now from Checking 0011**, then **Get a code**. Type the six digits and click **Pay $118.00**. Then click **Build my packet**.",
  },
  packet: {
    title: "Packet",
    what: "This is Michigan's real application, filled with safe fields only. Name, signature, Social Security number, and anything about what happened stay blank.",
    why: "Try turning Wi-Fi off, going back one page, and building the packet again; it still works. The packet is made in your browser, so nothing here needs a server.",
    next: "Click **See your garden**.",
  },
  track: {
    title: "Track",
    what: "Each cost is a plant that grows when something real happens. It sprouts when confirmed, leafs when a document is attached, buds when the claim is filed, and blooms when the program pays. The $325 never grows.",
    why: "A claim can take months. The garden shows where each dollar stands, and the filing deadline stays in view.",
    next: "That is the whole path. Read the one-page summary:",
    link: { href: TOUR_SUMMARY, label: "What you just saw" },
  },
};

// "Click **Find my costs**." as text and bold parts, for rendering and for tests.
export function boldParts(text: string): { text: string; bold: boolean }[] {
  return text
    .split("**")
    .map((part, i) => ({ text: part, bold: i % 2 === 1 }))
    .filter((p) => p.text);
}
