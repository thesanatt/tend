"use client";

// The privacy line's memory for this tab. The flow's state lives in memory, so after a reload the line
// used to leave out a payment or a share link the tab had sent. The tab keeps two flags in
// sessionStorage: that something was sent, and that a state was picked. Never a kind, a time, an
// amount, a payee, an id, or a key: after a reload, the next person at a shared device learns only
// that this tab sent something, not that it was a payment or when. Only a reload keeps the flags
// (dropUnlessReload). The tab also forgets them when the claim on this device ends (forgetKeptSends),
// and when Exit this page clears the rest of the tab (components/QuickExit.tsx).
import { useSyncExternalStore } from "react";
import { SENT_KEY } from "@/lib/keys";

export interface Kept {
  sent: boolean;
  state: boolean;
}

const NONE: Kept = { sent: false, state: false };

// Storage can be blocked (private windows, strict settings); the flags then last until a reload.
let memory: Kept = NONE;

// A closed tab the browser reopens (Cmd+Shift+T, History) gets its sessionStorage back, and that load
// counts as back_forward, so whoever reopened it would see what the tab sent. Only a reload carries
// the flags over; any other load, or a browser that cannot say, starts them over, and the line then
// vouches only for the new page (en.privacy.quiet).
export function dropUnlessReload(navigationType: string | undefined): void {
  if (navigationType === "reload") return;
  try {
    window.sessionStorage.removeItem(SENT_KEY);
  } catch {
    // no storage here
  }
}

function navigationType(): string | undefined {
  try {
    return (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type;
  } catch {
    return undefined;
  }
}

// What was stored is data from the tab: only the two flags, as true, count.
export function parseKept(raw: string | null): Kept {
  if (!raw) return NONE;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return NONE;
    const keys = Object.keys(v);
    if (!keys.length || keys.some((k) => k !== "sent" && k !== "state")) return NONE;
    const o = v as Record<string, unknown>;
    if (keys.some((k) => o[k] !== true)) return NONE;
    return { sent: o.sent === true, state: o.state === true };
  } catch {
    return NONE;
  }
}

function read(): Kept {
  try {
    return parseKept(window.sessionStorage.getItem(SENT_KEY));
  } catch {
    return memory;
  }
}

// What the tab kept from before this page loaded. What this page sends is on its own line already,
// so only these flags speak for pages before a reload.
let before: Kept = NONE;
const listeners = new Set<() => void>();

// Once per page, before the line first reads the flags. Steps inside the app and pages the browser's
// back cache restores do not run modules again.
if (typeof window !== "undefined") {
  dropUnlessReload(navigationType());
  before = read();
  memory = before;
}

function write(next: Kept) {
  memory = next;
  try {
    const flags = Object.fromEntries(Object.entries(next).filter(([, v]) => v));
    window.sessionStorage.setItem(SENT_KEY, JSON.stringify(flags));
  } catch {
    // blocked storage: the copy in memory still serves this page
  }
}

function keep(flag: keyof Kept): void {
  if (typeof window === "undefined") return;
  // Exit this page has cleared the tab; a reply that lands after it must not write it back.
  if (document.documentElement.dataset.exiting) return;
  const now = read();
  if (now[flag]) return;
  write({ ...now, [flag]: true });
}

// Something left the device: a payment, a share, a bank read, a cloud AI request.
export function keepSend(): void {
  keep("sent");
}

// A request named a state, or a state was picked.
export function keepStatePick(): void {
  keep("state");
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getBefore = () => before;

// null on the server and while the page hydrates, when this tab's memory cannot be read yet.
export function useKeptSends(): Kept | null {
  return useSyncExternalStore(subscribe, getBefore, () => null);
}

// The claim ended here: Close Tend on a claim never saved, or saved progress deleted or saved over
// (FlowProvider). As after Exit this page, the next person at the device must not learn from the
// line that this tab sent anything.
export function forgetKeptSends(): void {
  memory = NONE;
  before = NONE;
  try {
    window.sessionStorage.removeItem(SENT_KEY);
  } catch {
    // no storage here
  }
  listeners.forEach((l) => l());
}

// Tests only: the page loading again after a reload, without loading the module again.
export function reloadKeptForTests(): void {
  before = read();
  memory = before;
  listeners.forEach((l) => l());
}
