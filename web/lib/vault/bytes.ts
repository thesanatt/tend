// Byte helpers shared by the vault and share links. base64url carries no padding, so it fits in a
// URL fragment unchanged.

export type Bytes = Uint8Array<ArrayBuffer>;

export function randomBytes(n: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function utf8(text: string): Bytes {
  return new TextEncoder().encode(text) as Bytes;
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function toB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const B64URL = /^[A-Za-z0-9_-]*$/;

export function isB64url(text: string): boolean {
  return B64URL.test(text) && text.length % 4 !== 1;
}

export function fromB64url(text: string): Bytes {
  if (!isB64url(text)) throw new TypeError("not base64url");
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function wipe(bytes: Uint8Array | null | undefined): void {
  bytes?.fill(0);
}
