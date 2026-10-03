// lib/share: end-to-end encrypted share links (docs/PRIVACY.md, lib/contracts.ts Share).
//
// seal() makes a fresh 256-bit key, encrypts the packet in this browser with AES-256-GCM, and sends
// the server only the ciphertext, the IV, an expiry, and the open-once choice. The key goes into the
// link's fragment (/share#<id>.<key>), which browsers never send to a server. open() fetches the
// ciphertext by id and decrypts it here. The server cannot read a share, and neither can anyone
// holding only the id.
import type { Share, SharedPacket } from "../contracts";
import { fromB64url, fromUtf8, isB64url, toB64url, utf8, type Bytes } from "../vault/bytes";

export const SHARE_ENDPOINT = "/api/shares";
// The API's first sealed-share route (POST /api/share with ciphertext and nonce). Used only when
// SHARE_ENDPOINT is not there.
export const LEGACY_ENDPOINT = "/api/share";
export const VIEWER_PATH = "/share";
export const MAX_EXPIRES_HOURS = 168;
const AAD = utf8("tend.share.v1");
const FORMAT = "tend.share/1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const MAX_CIPHERTEXT_CHARS = 8_000_000;
const TIMEOUT_MS = 15_000;

export type ShareErrorCode =
  | "bad_link" // the link is cut off or mistyped
  | "bad_options"
  | "not_found"
  | "gone" // expired, turned off, or already opened once
  | "bad_key" // the ciphertext does not open with this key: wrong key or changed data
  | "bad_packet"
  | "too_large"
  | "unavailable" // no share route on this server (the app is running without the API)
  | "network"
  | "server";

const MESSAGES: Record<ShareErrorCode, string> = {
  bad_link: "This link is not complete. Ask the person who shared it to send the whole link again.",
  bad_options: "A share link can last from 1 hour to 7 days.",
  not_found: "This link does not work. It may be mistyped, or it was turned off.",
  gone: "This link no longer works. It expired, was turned off, or was already opened once.",
  bad_key: "This link could not open the shared claim. It may be cut off, or the data was changed.",
  bad_packet: "The shared claim opened but is not in a form Tend can show.",
  too_large: "This claim is too large to share as a link.",
  unavailable: "Sharing needs Tend's server, and it is not connected here. No link was made.",
  network: "Tend could not reach its server. Check the connection and try again.",
  server: "Tend's server could not handle this right now. Try again in a minute.",
};

export class ShareError extends Error {
  constructor(
    readonly code: ShareErrorCode,
    message: string = MESSAGES[code],
  ) {
    super(message);
    this.name = "ShareError";
  }
}

export interface ShareMeta {
  id: string;
  expires_at: string | null;
  once: boolean;
  created_at: string | null;
}

export interface SealedShare {
  url: string;
  id: string;
  expires_at: string | null;
  once: boolean;
}

export interface TendShare extends Share {
  seal(packet: SharedPacket, opts: { expires_hours: number; once: boolean }): Promise<SealedShare>;
  openWithMeta(url: string): Promise<{ packet: SharedPacket; meta: ShareMeta }>;
}

export interface ShareConfig {
  endpoint?: string;
  // null turns the fallback to the older /api/share route off.
  legacyEndpoint?: string | null;
  fetch?: typeof fetch;
  // Prefix for links. Defaults to this page's origin; null gives a path ("/share#...").
  origin?: string | null;
  viewerPath?: string;
}

const ID = /^[A-Za-z0-9_-]{8,128}$/;

// Accepts a full link, "/share#id.key", "#id.key", or "id.key". Punctuation pasted after the link
// ("...key)." in a message) is dropped; the key alphabet never contains it.
export function parseShareLink(link: string): { id: string; key: string } {
  const text = link.trim().replace(/[^A-Za-z0-9_-]+$/, "");
  const hash = text.indexOf("#");
  const fragment = hash === -1 ? text : text.slice(hash + 1);
  const dot = fragment.lastIndexOf(".");
  const id = fragment.slice(0, dot);
  const key = fragment.slice(dot + 1);
  if (dot <= 0 || !ID.test(id) || key.length !== 43 || !isB64url(key)) throw new ShareError("bad_link");
  return { id, key };
}

function isPacket(v: unknown): v is SharedPacket {
  const p = v as SharedPacket | null;
  return (
    !!p &&
    typeof p === "object" &&
    typeof p.st === "string" &&
    /^[A-Z]{2}$/.test(p.st) &&
    typeof p.created_at === "string" &&
    !!p.input &&
    Array.isArray(p.input.items) &&
    !!p.input.context &&
    !!p.output &&
    Array.isArray(p.output.lines) &&
    !!p.output.totals &&
    !!p.output.checks &&
    (p.notes === undefined || typeof p.notes === "string")
  );
}

const subtle = () => globalThis.crypto.subtle;

async function encrypt(packet: SharedPacket): Promise<{ key: Bytes; iv: Bytes; ciphertext: string }> {
  const key = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const aes = await subtle().importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const plain = utf8(JSON.stringify({ format: FORMAT, packet }));
  const ct = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: AAD, tagLength: 128 }, aes, plain);
  plain.fill(0);
  return { key, iv, ciphertext: toB64url(new Uint8Array(ct)) };
}

async function decrypt(keyText: string, ivText: string, ciphertext: string): Promise<SharedPacket> {
  let plain: Bytes;
  try {
    const key = fromB64url(keyText);
    const iv = fromB64url(ivText);
    if (key.length !== KEY_BYTES || iv.length !== IV_BYTES) throw new Error("size");
    const aes = await subtle().importKey("raw", key, "AES-GCM", false, ["decrypt"]);
    key.fill(0);
    const pt = await subtle().decrypt(
      { name: "AES-GCM", iv, additionalData: AAD, tagLength: 128 },
      aes,
      fromB64url(ciphertext),
    );
    plain = new Uint8Array(pt);
  } catch {
    throw new ShareError("bad_key");
  }
  let doc: { format?: string; packet?: unknown };
  try {
    doc = JSON.parse(fromUtf8(plain));
  } catch {
    throw new ShareError("bad_packet");
  } finally {
    plain.fill(0);
  }
  if (doc?.format !== FORMAT || !isPacket(doc.packet)) throw new ShareError("bad_packet");
  return doc.packet;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

type Route = "primary" | "legacy";

export function createShare(config: ShareConfig = {}): TendShare {
  const endpoint = (config.endpoint ?? SHARE_ENDPOINT).replace(/\/$/, "");
  const legacy = config.legacyEndpoint === undefined ? LEGACY_ENDPOINT : config.legacyEndpoint;
  const viewer = config.viewerPath ?? VIEWER_PATH;
  // The route that answered last; tried first next time.
  let preferred: Route = "primary";

  async function call(path: string, init: RequestInit): Promise<Response> {
    const f = config.fetch ?? globalThis.fetch;
    try {
      return await f(path, {
        ...init,
        // Nothing about the sharer rides along: no cookies, no referrer, no cached copy.
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ShareError("network");
    }
  }

  // A 404 or 405 can mean "no such route here" as well as "no such share", so the other route
  // gets a turn before the answer counts. The last answer stands.
  async function attempt(paths: Record<Route, string | null>, init: RequestInit, body?: Record<Route, unknown>) {
    const order: Route[] = preferred === "legacy" ? ["legacy", "primary"] : ["primary", "legacy"];
    const routes = order.filter((r) => paths[r] !== null);
    let res: Response | null = null;
    let used: Route = routes[0];
    for (const r of routes) {
      used = r;
      res = await call(paths[r]!, body ? { ...init, body: JSON.stringify(body[r]) } : init);
      if (res.status !== 404 && res.status !== 405) break;
    }
    if (res!.ok) preferred = used;
    return { res: res!, used };
  }

  async function fail(res: Response): Promise<never> {
    if (res.status === 404) throw new ShareError("not_found");
    if (res.status === 410) throw new ShareError("gone");
    if (res.status === 413) throw new ShareError("too_large");
    if (res.status === 400 || res.status === 422) throw new ShareError("server", "Tend's server refused this share.");
    throw new ShareError("server");
  }

  async function json(res: Response): Promise<Record<string, unknown>> {
    try {
      const body = await res.json();
      if (body && typeof body === "object") return body as Record<string, unknown>;
    } catch {
      // fall through
    }
    throw new ShareError("server");
  }

  const at = (id: string) => ({
    primary: `${endpoint}/${encodeURIComponent(id)}`,
    legacy: legacy ? `${legacy}/${encodeURIComponent(id)}` : null,
  });

  function linkFor(id: string, key: string): string {
    const origin =
      config.origin === undefined
        ? typeof location !== "undefined" && location.origin && location.origin !== "null"
          ? location.origin
          : ""
        : (config.origin ?? "");
    return `${origin.replace(/\/$/, "")}${viewer}#${id}.${key}`;
  }

  async function openWithMeta(link: string) {
    const { id, key } = parseShareLink(link);
    const { res } = await attempt(at(id), { method: "GET", headers: { accept: "application/json" } });
    if (!res.ok) await fail(res);
    const body = await json(res);
    const ciphertext = str(body.ciphertext);
    const iv = str(body.iv) ?? str(body.nonce);
    // A share the server can read (made before end-to-end sharing) has no ciphertext to open.
    if (!ciphertext || !iv) throw new ShareError("bad_packet", "This link is not an encrypted Tend share.");
    const packet = await decrypt(key, iv, ciphertext);
    const meta: ShareMeta = {
      id,
      expires_at: str(body.expires_at),
      once: body.once === true || body.open_once === true,
      created_at: str(body.created_at),
    };
    return { packet, meta };
  }

  return {
    async seal(packet, opts) {
      const hours = opts.expires_hours;
      if (!Number.isInteger(hours) || hours < 1 || hours > MAX_EXPIRES_HOURS) throw new ShareError("bad_options");
      if (!isPacket(packet)) throw new ShareError("bad_packet", "This claim is missing parts, so it was not shared.");
      const once = opts.once === true;
      const { key, iv, ciphertext } = await encrypt(packet);
      const keyText = toB64url(key);
      key.fill(0);
      if (ciphertext.length > MAX_CIPHERTEXT_CHARS) throw new ShareError("too_large");
      const ivText = toB64url(iv);
      // Only these fields leave the device. The key is not among them.
      const { res } = await attempt(
        { primary: endpoint, legacy },
        { method: "POST", headers: { "content-type": "application/json", accept: "application/json" } },
        {
          primary: { ciphertext, iv: ivText, alg: "AES-256-GCM", expires_hours: hours, once },
          legacy: { ciphertext, nonce: ivText, alg: "AES-256-GCM", ttl_hours: hours, open_once: once },
        },
      );
      if (res.status === 404 || res.status === 405) throw new ShareError("unavailable");
      if (!res.ok) await fail(res);
      const body = await json(res);
      const id = str(body.id) ?? str(body.token);
      if (!id || !ID.test(id)) throw new ShareError("server", "Tend's server sent back a link id Tend cannot use.");
      return {
        url: linkFor(id, keyText),
        id,
        expires_at: str(body.expires_at),
        once: body.once === true || body.open_once === true || once,
      };
    },

    async open(link) {
      return (await openWithMeta(link)).packet;
    },

    openWithMeta,

    async revoke(idOrLink) {
      const id = idOrLink.includes("#") || idOrLink.includes(".") ? parseShareLink(idOrLink).id : idOrLink.trim();
      if (!ID.test(id)) throw new ShareError("bad_link");
      const { res } = await attempt(at(id), { method: "DELETE" });
      // Already off counts as off.
      if (res.ok || res.status === 404 || res.status === 410) return;
      await fail(res);
    },
  };
}

// The app's share client: /api/shares on this site, links made for this site's /share page.
export const share: TendShare = createShare();
