// Shared fixtures for the trust layer tests (vault, share, packet): Rowan's fictional claim, the
// rules, a small in-memory IndexedDB, and a share server that records every request it gets.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FormSpec } from "@/lib/packet";
import type { EngineInput, EngineOutput, Jurisdiction } from "@/lib/types";

export const webDir = path.resolve(import.meta.dirname, "..");
export const repoDir = path.resolve(webDir, "..");
export const verifiedDir = path.join(repoDir, "rules", "verified");
export const hasVerified = existsSync(path.join(verifiedDir, "MI.json"));

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

// The copy the browser reads (public/data/law) and the corpus itself (rules/verified).
export const webLaw = (st: string) => readJson<Jurisdiction>(path.join(webDir, "public", "data", "law", `${st}.json`));
export const verifiedLaw = (st: string) => readJson<Jurisdiction>(path.join(verifiedDir, `${st}.json`));
export const blankForm = async (spec: FormSpec) => new Uint8Array(readFileSync(path.join(webDir, "public", spec.path)));

export const rowanInput = () => readJson<EngineInput>(path.join(webDir, "fixtures", "rowan-mi.input.json"));
export const rowanOutput = () => readJson<EngineOutput>(path.join(webDir, "fixtures", "rowan-mi.output.json"));

// --- IndexedDB, just the calls lib/vault/store.ts makes ---------------------------------------

type Handler = (() => void) | null;
interface FakeRequest<T = unknown> {
  result: T;
  error: DOMException | null;
  onsuccess: Handler;
  onerror: Handler;
  onupgradeneeded?: Handler;
  onblocked?: Handler;
}

export function fakeIndexedDB() {
  const dbs = new Map<string, Map<string, Map<unknown, unknown>>>();
  const request = <T>(): FakeRequest<T> =>
    ({ result: undefined, error: null, onsuccess: null, onerror: null }) as unknown as FakeRequest<T>;

  const factory = {
    open(name: string) {
      const req = request<unknown>();
      queueMicrotask(() => {
        const fresh = !dbs.has(name);
        if (fresh) dbs.set(name, new Map());
        const stores = dbs.get(name)!;
        req.result = {
          objectStoreNames: { contains: (n: string) => stores.has(n) },
          createObjectStore: (n: string) => stores.set(n, new Map()),
          transaction(storeName: string) {
            const records = stores.get(storeName)!;
            const tx = { error: null, oncomplete: null as Handler, onerror: null as Handler, onabort: null as Handler };
            const done = <T>(result: T) => {
              const r = request<T>();
              r.result = result;
              return r;
            };
            Object.assign(tx, {
              objectStore: () => ({
                get: (k: unknown) => done(structuredClone(records.get(k))),
                put: (v: unknown, k: unknown) => (records.set(k, structuredClone(v)), done(k)),
                delete: (k: unknown) => (records.delete(k), done(undefined)),
                clear: () => (records.clear(), done(undefined)),
              }),
            });
            setTimeout(() => tx.oncomplete?.(), 0);
            return tx;
          },
          close() {},
          onversionchange: null,
          onclose: null,
        };
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
    deleteDatabase(name: string) {
      const req = request<undefined>();
      queueMicrotask(() => {
        dbs.delete(name);
        req.onsuccess?.();
      });
      return req;
    },
  };
  return { factory: factory as unknown as IDBFactory, databases: () => [...dbs.keys()] };
}

// --- A share server: /api/shares (new) and /api/share (the API's first sealed route) ----------

export interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

interface Stored {
  ciphertext: string;
  iv: string;
  once: boolean;
  opened: boolean;
  revoked: boolean;
  expired: boolean;
  expires_at: string;
}

export function fakeShareServer(routes: "primary" | "legacy" | "none" = "primary") {
  const calls: Captured[] = [];
  const shares = new Map<string, Stored>();
  let n = 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === "string" ? init.body : init.body == null ? null : String(init.body);
    calls.push({ url, method, headers, body });

    const m = url.match(/^\/api\/(shares|share)(?:\/([^/?#]+))?$/);
    if (!m) return new Response("<html>404</html>", { status: 404, headers: { "content-type": "text/html" } });
    const kind = m[1] === "shares" ? "primary" : "legacy";
    if (routes === "none" || kind !== routes) return json(404, { detail: "Not Found" });
    const id = m[2] ? decodeURIComponent(m[2]) : null;

    if (method === "POST" && !id) {
      const b = JSON.parse(body ?? "{}");
      const token = `tok_${String(++n).padStart(28, "0")}`;
      const once = kind === "primary" ? b.once : b.open_once;
      const expires_at = "2026-10-10T16:20:00Z";
      shares.set(token, {
        ciphertext: b.ciphertext,
        iv: kind === "primary" ? b.iv : b.nonce,
        once,
        opened: false,
        revoked: false,
        expired: false,
        expires_at,
      });
      return kind === "primary"
        ? json(200, { id: token, expires_at, once })
        : json(200, { token, path: `/share/${token}`, expires_at, sealed: true, open_once: once });
    }
    if (!id) return json(405, { detail: "Method Not Allowed" });
    const s = shares.get(id);
    if (method === "GET") {
      if (!s) return json(404, { detail: "This link is not valid." });
      if (s.revoked || s.expired) return json(410, { detail: "This link has expired." });
      if (s.once && s.opened) return json(410, { detail: "This link could be opened once, and it has been." });
      s.opened = true;
      return kind === "primary"
        ? json(200, {
            id,
            ciphertext: s.ciphertext,
            iv: s.iv,
            once: s.once,
            expires_at: s.expires_at,
            created_at: "2026-10-03T16:20:00Z",
          })
        : json(200, {
            token: id,
            sealed: true,
            alg: "AES-256-GCM",
            nonce: s.iv,
            ciphertext: s.ciphertext,
            open_once: s.once,
            expires_at: s.expires_at,
            created_at: "2026-10-03T16:20:00Z",
          });
    }
    if (method === "DELETE") {
      if (!s || s.revoked) return json(404, { detail: "This link is not valid or was already turned off." });
      s.revoked = true;
      return new Response(null, { status: 204 });
    }
    return json(405, { detail: "Method Not Allowed" });
  };

  return { fetch: fetchImpl as typeof fetch, calls, shares };
}
