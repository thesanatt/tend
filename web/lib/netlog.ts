// What actually left this page, seen where every request passes: window.fetch. The privacy line
// is built from these, so it can only say what was really sent (docs/PRIVACY.md). Loading the app
// and the public law (GETs of pages, scripts, law files, the forms) is not a send. A request whose
// path names a state (a state page, a law file, Michigan's form) still tells the server which state,
// so it is reported apart, as a state pick (onStateRequest), and the line says so (PrivacyLine). A
// request that fails while the device is offline sent nothing and is not reported.
import STATES from "./states.json";

export type NetKind =
  | "payment_setup" // the amount, account, and payee, to get a confirm code
  | "payment" // a confirmed payment that reached the bank service
  | "share" // a sealed packet (ciphertext only)
  | "bank" // a read of the demo bank through the relay
  | "server_engine" // the claim, to check the law on the server
  | "cloud_rows" // unsorted rows, to cloud AI, after the survivor said yes
  | "cloud_bill" // a bill file, to cloud AI, after the survivor said yes
  | "other"; // anything the flow did not expect; shown so it is never hidden

export interface NetSend {
  kind: NetKind;
  at: string;
  method: string;
  path: string; // same-origin path, or the origin of a request to another site
  status: number | null; // null when no answer came back (a timeout)
  // A key for the same send reported twice (by the flow and here): "pay:<action id>", "share:<id>".
  ref?: string;
  amount_cents?: number;
  to?: string;
  action_id?: string;
  dry_run?: boolean;
  // A payment with no clear answer (a server error or none at all): it may have reached the bank.
  unsure?: boolean;
}

type Listener = (send: NetSend) => void;

const CODES = new Set(STATES.map((s) => s.st));
// The paths that carry a state's code: /mi and /law/MI, the law files the flow loads, the form, and
// the API's copy of the law when a file is missing (lib/api.ts, lib/engine/wasm.ts, lib/packet).
const STATE_PATHS = [
  /^\/([a-z]{2})\/?$/i,
  /^\/law\/([a-z]{2})\/?$/i,
  /^\/data\/(?:law|ir)\/([a-z]{2})\.json$/i,
  /^\/engine\/laws\/([a-z]{2})\.tlaw$/i,
  /^\/forms\/([a-z]{2})\.pdf$/i,
  /^\/api\/jurisdictions\/([a-z]{2})(?:\/|$)/i,
];

// The state a same-origin URL names, by its path or by ?st=, or null.
export function stateNamedIn(url: URL, origin: string): string | null {
  if (url.origin !== origin) return null;
  for (const re of STATE_PATHS) {
    const code = re.exec(url.pathname)?.[1]?.toUpperCase();
    if (code && CODES.has(code)) return code;
  }
  const st = url.searchParams.get("st")?.toUpperCase();
  return st && CODES.has(st) ? st : null;
}

// Next fetches the pages that links point to before anyone picks one. Those requests name a state
// the visitor did not choose, so they are not a pick; opening the page is (FlowProvider).
function isPrefetch(input: RequestInfo | URL, init?: RequestInit): boolean {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  return headers.has("next-router-prefetch");
}

const stateListeners = new Set<() => void>();

// Every request that names a state, with no code: the line needs only to know that one went.
export function onStateRequest(fn: () => void): () => void {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}

function emitState() {
  for (const fn of stateListeners) {
    try {
      fn();
    } catch {
      // as in emit
    }
  }
}

const listeners = new Set<Listener>();
const sends: NetSend[] = [];
let installed: { target: typeof globalThis; real: typeof fetch; wrapper: typeof fetch } | null = null;

// Which kind of send a request is, or null for loading the app and public data.
export function classifyRequest(method: string, url: URL, origin: string): NetKind | null {
  const m = method.toUpperCase();
  if (url.origin !== origin) return m === "GET" && url.protocol === "data:" ? null : "other";
  const p = url.pathname;
  // The program's demo payout on Track (components/bank/PayoutDemo) reports itself as a payment
  // before it goes, whatever the bank answers; undoing it sends only the persona's id.
  if (/^\/api\/bank\/[^/]+\/payout$/.test(p) && (m === "POST" || m === "DELETE")) return null;
  if (m === "GET" || m === "HEAD") return p.startsWith("/api/bank/") ? "bank" : null;
  if (m === "DELETE" && p.startsWith("/api/shares/")) return null; // stopping a link sends only its id
  if (m !== "POST") return "other";
  if (p === "/api/actions/propose") return "payment_setup";
  if (p === "/api/actions/confirm") return "payment";
  if (p === "/api/shares" || p === "/api/share") return "share";
  if (p === "/api/claim") return "server_engine";
  if (p === "/api/ai/classify") return "cloud_rows";
  if (p === "/api/ai/bill") return "cloud_bill";
  return "other";
}

function emit(send: NetSend) {
  sends.push(send);
  for (const fn of listeners) {
    try {
      fn(send);
    } catch {
      // A listener's problem never breaks the request that was made.
    }
  }
}

export function onNetSend(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Every send since the page loaded, oldest first.
export function netSends(): readonly NetSend[] {
  return sends;
}

const bodyJson = (body: BodyInit | null | undefined): Record<string, unknown> | null => {
  if (typeof body !== "string") return null;
  try {
    const v = JSON.parse(body) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const cents = (v: unknown) => (Number.isSafeInteger(v) ? (v as number) : undefined);

// The details a send carries, from the request the flow wrote and, where the server names it, the
// answer (the action id of a proposal, the id of a share).
async function details(kind: NetKind, sent: Record<string, unknown> | null, res: Response | null) {
  let got: Record<string, unknown> | null = null;
  if (res && (kind === "payment_setup" || kind === "share" || kind === "payment")) {
    try {
      got = (await res.clone().json()) as Record<string, unknown>;
    } catch {
      got = null;
    }
  }
  const action = str(got?.action_id) ?? str(sent?.action_id);
  const out: Partial<NetSend> = {};
  if (kind === "payment_setup") {
    out.amount_cents = cents(sent?.amount_cents);
    out.to = str(sent?.payee);
    if (action) out.ref = `setup:${action}`;
  } else if (kind === "payment") {
    out.amount_cents = cents(got?.amount_cents);
    out.to = str(got?.payee);
    if (got && typeof got.dry_run === "boolean") out.dry_run = got.dry_run;
    if (action) out.ref = `pay:${action}`;
  } else if (kind === "share") {
    const id = str(got?.id) ?? str(got?.share_id) ?? str(got?.token);
    if (id) out.ref = `share:${id}`;
  } else if (kind === "server_engine" || kind === "bank") {
    out.ref = kind;
  }
  if (action) out.action_id = action;
  return out;
}

// The API's word that a payment failed before any money could move (maybe_applied false). Without
// it, a server error on a payment may have gone through.
async function nothingMoved(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { maybe_applied?: unknown } | null;
    return body?.maybe_applied === false;
  } catch {
    return false;
  }
}

// No network at all: the browser says it is offline. Such a request never left the device.
export function offline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

// Wraps the page's fetch once. Requests work exactly as before; sends are reported after they go.
export function installNetLog(target: typeof globalThis = globalThis): void {
  if (typeof target.fetch !== "function") return;
  // Already watching, unless something replaced fetch since (then the new one is wrapped).
  if (installed?.target === target && target.fetch === installed.wrapper) return;
  const real = target.fetch.bind(target);
  const origin = target.location?.origin ?? "http://localhost";
  const wrapper = async function tendFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let url: URL;
    let method = init?.method ?? "GET";
    try {
      if (input instanceof Request) {
        url = new URL(input.url, origin);
        method = init?.method ?? input.method;
      } else url = new URL(String(input), origin);
    } catch {
      return real(input, init);
    }
    const kind = classifyRequest(method, url, origin);
    if (!kind) {
      if (stateNamedIn(url, origin) && !isPrefetch(input, init) && !offline()) emitState();
      return real(input, init);
    }
    const wasOffline = offline();
    const sent = bodyJson(init?.body);
    const base = {
      kind,
      method: method.toUpperCase(),
      path: url.origin === origin ? url.pathname : url.origin,
    };
    try {
      const res = await real(input, init);
      // A confirm the service refused (a wrong or used code), or one the bank refused before any money
      // moved, sent nothing new off the device: the amount and payee went with the code request.
      const refused = kind === "payment" && res.status >= 400 && (res.status < 500 || (await nothingMoved(res)));
      if (!refused) {
        const extra = await details(kind, sent, res);
        const unsure = kind === "payment" && res.status >= 500 ? { unsure: true } : {};
        emit({ ...base, ...extra, ...unsure, status: res.status, at: new Date().toISOString() });
      }
      return res;
    } catch (err) {
      // Offline: nothing reached a server. Online, a request that failed with no answer (a timeout, a
      // dropped connection, a TypeError) may have arrived first, so it is reported. A line too many is
      // the safe mistake.
      if (!wasOffline && !offline()) {
        const extra = await details(kind, sent, null);
        const unsure = kind === "payment" ? { unsure: true } : {};
        emit({ ...base, ...extra, ...unsure, status: null, at: new Date().toISOString() });
      }
      throw err;
    }
  } as typeof fetch;
  installed = { target, real, wrapper };
  target.fetch = wrapper;
}

// Tests only: put the real fetch back and forget what was seen.
export function resetNetLogForTests(): void {
  if (installed) installed.target.fetch = installed.real;
  installed = null;
  sends.length = 0;
  listeners.clear();
  stateListeners.clear();
}
