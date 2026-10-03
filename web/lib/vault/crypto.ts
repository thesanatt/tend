// WebCrypto building blocks for the vault (docs/PRIVACY.md): AES-256-GCM boxes, PBKDF2-SHA-256 for
// passphrases, HKDF-SHA-256 for passkey (PRF) secrets. Every derived key is non-extractable.
import { fromB64url, toB64url, utf8, type Bytes } from "./bytes";

export const PBKDF2_ITERATIONS = 600_000;
export const IV_BYTES = 12;
export const KEY_BYTES = 32;

// One sealed value: a fresh 96-bit IV and the ciphertext with its 128-bit tag, both base64url.
export interface Box {
  iv: string;
  ct: string;
}

export function isBox(value: unknown): value is Box {
  const v = value as Box | null;
  return !!v && typeof v === "object" && typeof v.iv === "string" && typeof v.ct === "string";
}

const subtle = () => globalThis.crypto.subtle;
const AES = { name: "AES-GCM", length: 256 } as const;

export async function keyFromPassphrase(passphrase: string, salt: Bytes, iterations: number): Promise<CryptoKey> {
  // NFKC so the same passphrase typed on another keyboard gives the same key.
  const material = await subtle().importKey("raw", utf8(passphrase.normalize("NFKC")), "PBKDF2", false, [
    "deriveKey",
  ]);
  return subtle().deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, material, AES, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function keyFromSecret(secret: Bytes, salt: Bytes, info: string): Promise<CryptoKey> {
  const material = await subtle().importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: utf8(info) }, material, AES, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function importAesKey(raw: Bytes): Promise<CryptoKey> {
  return subtle().importKey("raw", raw, AES, false, ["encrypt", "decrypt"]);
}

// The vault's data key splits into a record key and a key that hides record names.
export interface DataKeys {
  enc: CryptoKey;
  names: CryptoKey;
}

export async function dataKeys(raw: Bytes): Promise<DataKeys> {
  const material = await subtle().importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  const salt = utf8("tend.vault.v1");
  const enc = await subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: utf8("records") }, material, AES, false, [
    "encrypt",
    "decrypt",
  ]);
  const names = await subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: utf8("names") },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  return { enc, names };
}

// Storage slot for a record name: an HMAC, so the database does not even show what is saved.
export async function slotFor(names: CryptoKey, name: string): Promise<string> {
  const mac = new Uint8Array(await subtle().sign("HMAC", names, utf8(name)));
  return `r:${toB64url(mac.subarray(0, 16))}`;
}

export async function sealBytes(key: CryptoKey, plain: Bytes, aad: string): Promise<Box> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad), tagLength: 128 }, key, plain);
  return { iv: toB64url(iv), ct: toB64url(new Uint8Array(ct)) };
}

// Throws an OperationError when the key is wrong or a single bit of the box, or its label, changed.
export async function openBytes(key: CryptoKey, box: Box, aad: string): Promise<Bytes> {
  let iv: Bytes;
  let ct: Bytes;
  try {
    iv = fromB64url(box.iv);
    ct = fromB64url(box.ct);
  } catch {
    throw new DOMException("damaged box", "OperationError");
  }
  if (iv.length !== IV_BYTES) throw new DOMException("bad iv", "OperationError");
  const plain = await subtle().decrypt({ name: "AES-GCM", iv, additionalData: utf8(aad), tagLength: 128 }, key, ct);
  return new Uint8Array(plain);
}

// WebCrypto reports a failed AES-GCM check as OperationError.
export function isDecryptFailure(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === "OperationError" || name === "InvalidAccessError";
}
