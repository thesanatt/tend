"use client";

// The privacy line's memory for this tab. The flow's state lives in memory, so a reload used to turn
// the line back to "Nothing has left it." even after a payment or a share link. Each send's kind and
// time go to sessionStorage, never an amount, a payee, an id, or a key. The tab forgets them when it
// closes, and Exit this page clears them with the rest of the tab (components/QuickExit.tsx).
import { useSyncExternalStore } from "react";
import { SENT_KEY } from "@/lib/keys";
import type { SentEvent, SentKind } from "./state";

export interface KeptSend {
  kind: SentKind;
  at: string;
}

const KINDS = new Set<SentKind>([
  "payment",
  "payment_setup",
  "share",
  "bank",
  "server_engine",
  "cloud_rows",
  "cloud_bill",
  "other",
]);
const NONE: readonly KeptSend[] = [];

// Storage can be blocked (private windows, strict settings); the line then remembers until a reload.
let memory: readonly KeptSend[] = NONE;
let cache: { raw: string | null; list: readonly KeptSend[] } = { raw: null, list: NONE };
const listeners = new Set<() => void>();
// This page's own bookkeeping, never stored: the refs already kept (a screen and lib/netlog report
// the same send), and when each payment was started, so the payment that follows replaces it.
const seen = new Set<string>();
const started = new Map<string, string>();

// What was stored is data from the tab: only well-formed entries count.
function parse(raw: string | null): readonly KeptSend[] {
  if (!raw) return NONE;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return NONE;
    return v.filter(
      (e): e is KeptSend =>
        !!e &&
        typeof e === "object" &&
        KINDS.has((e as KeptSend).kind) &&
        typeof (e as KeptSend).at === "string" &&
        Object.keys(e).length === 2,
    );
  } catch {
    return NONE;
  }
}

function read(): readonly KeptSend[] {
  try {
    const raw = window.sessionStorage.getItem(SENT_KEY);
    if (raw !== cache.raw) cache = { raw, list: parse(raw) };
    return cache.list;
  } catch {
    return memory;
  }
}

function write(list: readonly KeptSend[]) {
  memory = list;
  try {
    window.sessionStorage.setItem(SENT_KEY, JSON.stringify(list));
  } catch {
    // blocked storage: the copy in memory still serves this page
  }
  listeners.forEach((l) => l());
}

export function keepSend(e: Pick<SentEvent, "kind" | "at" | "ref" | "action_id">): void {
  if (typeof window === "undefined") return;
  // Exit this page has cleared the tab; a reply that lands after it must not write it back.
  if (document.documentElement.dataset.exiting) return;
  if (e.ref) {
    if (seen.has(e.ref)) return;
    seen.add(e.ref);
  }
  let list = read();
  // The line says a payment that went ahead once, as a payment (PrivacyLine.privacyText).
  const setupAt = e.kind === "payment" && e.action_id ? started.get(e.action_id) : undefined;
  if (setupAt) list = list.filter((k) => !(k.kind === "payment_setup" && k.at === setupAt));
  if (e.kind === "payment_setup" && e.action_id) started.set(e.action_id, e.at);
  write([...list, { kind: e.kind, at: e.at }]);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// null on the server and while the page hydrates, when this tab's memory cannot be read yet.
export function useKeptSends(): readonly KeptSend[] | null {
  return useSyncExternalStore(subscribe, read, () => null);
}

// The claim's own sends with what this tab kept from before a reload, each send once, oldest first.
export function withKept(sent: SentEvent[], kept: readonly KeptSend[]): SentEvent[] {
  const have = new Set(sent.map((e) => `${e.kind} ${e.at}`));
  const extra = kept.filter((k) => !have.has(`${k.kind} ${k.at}`)).map((k) => ({ ...k, kept: true }));
  if (!extra.length) return sent;
  return [...sent, ...extra].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// Tests only: a fresh tab.
export function resetKeptSendsForTests(): void {
  seen.clear();
  started.clear();
  memory = NONE;
  cache = { raw: null, list: NONE };
  try {
    window.sessionStorage.removeItem(SENT_KEY);
  } catch {
    // no storage here
  }
  listeners.forEach((l) => l());
}
