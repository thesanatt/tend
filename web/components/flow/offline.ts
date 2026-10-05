"use client";

// Gets the survivor flow ready to run with the network off. In a production build it registers
// public/sw.js, which saves the flow's pages, the law engine, and every state's law (public files
// only). Then it tells the worker which files this page loaded before the worker was in charge, and
// loads the PDF reader and writer once, so a statement or a bill (or the sample statement) can still
// be read offline. When all of that is saved, <html data-offline="ready"> says so (the end-to-end
// tests wait for it).
import { useEffect, useRef, useSyncExternalStore } from "react";

// Whether this device has what it needs to run the flow offline, and whether it is offline now.
// The footer says both, so the presenter (and the survivor) can see it.
let ready = false;
const watchers = new Set<() => void>();
function markReady() {
  ready = true;
  for (const fn of watchers) fn();
}
function subscribe(fn: () => void) {
  watchers.add(fn);
  window.addEventListener("online", fn);
  window.addEventListener("offline", fn);
  return () => {
    watchers.delete(fn);
    window.removeEventListener("online", fn);
    window.removeEventListener("offline", fn);
  };
}
export type OfflineStatus = "online" | "ready" | "offline";
const snapshot = (): OfflineStatus => (navigator.onLine === false ? "offline" : ready ? "ready" : "online");

export function useOfflineStatus(): OfflineStatus {
  return useSyncExternalStore(subscribe, snapshot, () => "online");
}

export const SW_URL = "/sw.js";
// Every step, so moving between them works offline without a reload (a reload would clear what is
// only in memory).
export const FLOW_ROUTES = ["/check", "/gather", "/gather/bills", "/packet", "/track"];

export function offlineEnabled(): boolean {
  return process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_TEND_SW === "1";
}

export interface RouterLike {
  prefetch?: (href: string) => void;
  refresh?: () => void;
}

// Whether the worker was already in charge when this page loaded. If not, the page fetched each
// step's data before the worker could save it, so it is fetched again once.
let controlledAtLoad: boolean | null = null;

async function prepare(signal: { cancelled: boolean }, router: () => RouterLike | undefined) {
  const sw = navigator.serviceWorker;
  controlledAtLoad ??= Boolean(sw.controller);
  await sw.register(SW_URL, { scope: "/" });
  const reg = await sw.ready;
  if (signal.cancelled || !reg.active) return;
  if (!sw.controller) await new Promise((resolve) => sw.addEventListener("controllerchange", resolve, { once: true }));
  // Each step's page data, asked for through the worker so it is saved too. A refresh marks what
  // the page fetched before the worker existed as old, so the links on screen ask again.
  try {
    if (!controlledAtLoad) router()?.refresh?.();
    for (const href of FLOW_ROUTES) router()?.prefetch?.(href);
  } catch {
    // A step that cannot be fetched now loads the usual way later.
  }
  // Load the PDF reader now, through the worker, so it is saved for later; and pdf-lib, which builds
  // the sample statement (and fills the packet), so "Use a sample statement" works offline too.
  await import("@/lib/local/pdf").then((m) => m.pdfjs()).catch(() => undefined);
  await import("pdf-lib").catch(() => undefined);
  // Files only: scripts, styles, fonts, the engine, the law. A step's page data (?_rsc=) is not
  // here, because fetched again without Next's headers it would come back as a web page.
  const urls = performance
    .getEntriesByType("resource")
    .map((e) => e.name)
    .filter((u) => u.startsWith(location.origin))
    .filter((u) => /^\/(_next\/static|engine|data|forms)\//.test(new URL(u).pathname) && !u.includes("_rsc="));
  const answered = new Promise<void>((resolve) => {
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type !== "tend-ready") return;
      sw.removeEventListener("message", onMessage);
      resolve();
    };
    sw.addEventListener("message", onMessage);
    setTimeout(resolve, 20_000); // a busy worker still lets the page carry on
  });
  reg.active.postMessage({ type: "tend-files", urls });
  await answered;
  if (!signal.cancelled) {
    document.documentElement.dataset.offline = "ready";
    markReady();
  }
}

export function useOfflineReady(router?: RouterLike): void {
  const ref = useRef(router);
  useEffect(() => {
    ref.current = router;
  });
  useEffect(() => {
    if (!offlineEnabled() || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const signal = { cancelled: false };
    prepare(signal, () => ref.current).catch(() => {
      // Without a worker the flow still runs; it just needs the network to load again.
    });
    return () => {
      signal.cancelled = true;
    };
  }, []);
}
