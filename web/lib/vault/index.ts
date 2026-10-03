// lib/vault: the encrypted store on this device (docs/PRIVACY.md, lib/contracts.ts Vault).
//
// A random 256-bit data key encrypts every record with AES-256-GCM. The data key itself is kept
// only wrapped: under a key from the passphrase (PBKDF2-SHA-256, 600,000 iterations, random salt)
// and/or under a key from a passkey's PRF secret (HKDF-SHA-256). Unwrapped keys live in memory
// only, as non-extractable CryptoKeys; lock() drops them and the idle timer calls lock().
import type { Vault } from "../contracts";
import { fromB64url, fromUtf8, randomBytes, toB64url, utf8, wipe, type Bytes } from "./bytes";
import {
  dataKeys,
  isBox,
  isDecryptFailure,
  keyFromPassphrase,
  keyFromSecret,
  KEY_BYTES,
  openBytes,
  PBKDF2_ITERATIONS,
  sealBytes,
  slotFor,
  type Box,
  type DataKeys,
} from "./crypto";
import { DEFAULT_IDLE_MS, watchIdle, type IdleWatch } from "./idle";
import { PasskeyError, webAuthnPasskeys, type PasskeyProvider } from "./passkey";
import { idbStore, StorageUnavailableError, type VaultStore } from "./store";

export { DEFAULT_IDLE_MS, PBKDF2_ITERATIONS };
export { idbStore, memoryStore, type VaultStore } from "./store";
export { PasskeyError, webAuthnPasskeys, type PasskeyProvider } from "./passkey";
export { fromB64url, toB64url } from "./bytes";

export const MIN_PASSPHRASE = 6;

export type LockReason = "manual" | "idle" | "destroyed";

export type VaultErrorCode =
  | "exists" // create() when a vault is already saved here
  | "no_method" // create() with neither a passphrase nor a passkey
  | "weak_passphrase"
  | "locked" // get/set/delete while locked
  | "damaged" // a record failed its integrity check
  | "passkey_unsupported"
  | "passkey_cancelled"
  | "storage";

export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

export interface VaultConfig {
  store?: VaultStore;
  passkeys?: PasskeyProvider;
  // Lock after this long with no taps or keys. 0 turns the timer off. Default 5 minutes.
  idleMs?: number;
  // PBKDF2 rounds for new vaults. Unlocking always uses the count saved with the vault.
  iterations?: number;
  // Where taps and keys are heard (default: document).
  activity?: EventTarget | null;
  now?: () => number;
}

export interface Methods {
  passphrase: boolean;
  passkey: boolean;
}

export interface TendVault extends Vault {
  // Which ways to open the saved vault exist, or null when nothing is saved.
  methods(): Promise<Methods | null>;
  passkeyAvailable(): Promise<boolean>;
  delete(key: string): Promise<void>;
  lock(reason?: LockReason): void;
  // Counts as activity for the idle timer (the page's own taps and keys already do).
  touch(): void;
  onLock(listener: (reason: LockReason) => void): () => void;
}

interface Meta {
  v: 1;
  pass?: { salt: string; iterations: number; box: Box };
  key?: { id: string; salt: string; box: Box };
}

const META = "meta";
const WRAP = "tend.vault.v1.wrap:";
const RECORD = "tend.vault.v1.record:";
const PASSKEY_INFO = "tend.vault.v1.passkey";

function readMetaShape(raw: unknown): Meta | null {
  const m = raw as Meta | null;
  if (!m || typeof m !== "object" || m.v !== 1) return null;
  const pass =
    m.pass && typeof m.pass.salt === "string" && Number.isSafeInteger(m.pass.iterations) && isBox(m.pass.box);
  const key = m.key && typeof m.key.id === "string" && typeof m.key.salt === "string" && isBox(m.key.box);
  return pass || key ? m : null;
}

export function createVault(config: VaultConfig = {}): TendVault {
  let backing: VaultStore | null = config.store ?? null;
  let passkeys: PasskeyProvider | null = config.passkeys ?? null;
  const idleMs = config.idleMs ?? DEFAULT_IDLE_MS;
  const iterations = config.iterations ?? PBKDF2_ITERATIONS;
  const now = config.now ?? Date.now;

  let keys: DataKeys | null = null;
  let idle: IdleWatch | null = null;
  // Bumped by every lock, so an opening that finishes after a lock (Exit pressed while opening)
  // cannot leave the vault open.
  let epoch = 0;
  const listeners = new Set<(reason: LockReason) => void>();

  const store = () => (backing ??= idbStore());
  const keyring = () => (passkeys ??= webAuthnPasskeys());

  async function storage<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (e) {
      if (e instanceof VaultError) throw e;
      if (e instanceof StorageUnavailableError) throw new VaultError("storage", e.message);
      throw new VaultError("storage", "Tend could not reach this device's storage. Nothing was changed.");
    }
  }

  const readMeta = async () => readMetaShape(await storage(() => store().get(META)));

  function lock(reason: LockReason = "manual") {
    const was = keys !== null;
    keys = null;
    epoch += 1;
    idle?.stop();
    idle = null;
    if (was || reason === "destroyed") for (const fn of [...listeners]) fn(reason);
  }

  async function install(raw: Bytes, startedAt: number): Promise<boolean> {
    const derived = await dataKeys(raw);
    if (startedAt !== epoch) return false;
    idle?.stop();
    keys = derived;
    idle = idleMs > 0 ? watchIdle({ idleMs, onIdle: () => lock("idle"), target: config.activity, now }) : null;
    return true;
  }

  function current(): DataKeys {
    if (keys && idle?.expired()) lock("idle");
    if (!keys) throw new VaultError("locked", "Your saved work is locked. Open it to continue.");
    return keys;
  }

  async function unwrap(meta: Meta, opts: { passphrase?: string; passkey?: boolean }): Promise<Bytes | null> {
    if (typeof opts.passphrase === "string" && meta.pass) {
      const kek = await keyFromPassphrase(opts.passphrase, fromB64url(meta.pass.salt), meta.pass.iterations);
      return openBytes(kek, meta.pass.box, `${WRAP}pass`);
    }
    if (opts.passkey && meta.key) {
      const salt = fromB64url(meta.key.salt);
      let secret: Bytes | null = null;
      try {
        secret = await keyring().secret(meta.key.id, salt);
        const kek = await keyFromSecret(secret, salt, PASSKEY_INFO);
        return await openBytes(kek, meta.key.box, `${WRAP}key`);
      } finally {
        wipe(secret);
      }
    }
    return null;
  }

  const vault: TendVault = {
    async exists() {
      return (await readMeta()) !== null;
    },

    async methods() {
      const meta = await readMeta();
      return meta ? { passphrase: !!meta.pass, passkey: !!meta.key } : null;
    },

    async passkeyAvailable() {
      try {
        return await keyring().available();
      } catch {
        return false;
      }
    },

    async create(opts) {
      const startedAt = epoch;
      const passphrase = typeof opts.passphrase === "string" ? opts.passphrase : undefined;
      if (passphrase === undefined && !opts.passkey) {
        throw new VaultError("no_method", "Choose a passphrase or a passkey to lock your saved work.");
      }
      if (passphrase !== undefined && [...passphrase.normalize("NFKC")].length < MIN_PASSPHRASE) {
        throw new VaultError("weak_passphrase", `Use at least ${MIN_PASSPHRASE} characters.`);
      }
      if (await vault.exists()) {
        throw new VaultError("exists", "Saved work is already on this device. Open it, or delete it first.");
      }
      const raw = randomBytes(KEY_BYTES);
      try {
        const meta: Meta = { v: 1 };
        if (passphrase !== undefined) {
          const salt = randomBytes(16);
          const kek = await keyFromPassphrase(passphrase, salt, iterations);
          meta.pass = { salt: toB64url(salt), iterations, box: await sealBytes(kek, raw, `${WRAP}pass`) };
        }
        if (opts.passkey) {
          const salt = randomBytes(32);
          let secret: Bytes | null = null;
          try {
            const made = await keyring().register(salt);
            secret = made.secret;
            const kek = await keyFromSecret(secret, salt, PASSKEY_INFO);
            meta.key = { id: made.credentialId, salt: toB64url(salt), box: await sealBytes(kek, raw, `${WRAP}key`) };
          } catch (e) {
            if (e instanceof PasskeyError) {
              throw new VaultError(e.code === "cancelled" ? "passkey_cancelled" : "passkey_unsupported", e.message);
            }
            throw e;
          } finally {
            wipe(secret);
          }
        }
        await storage(() => store().put(META, meta));
        await install(raw, startedAt);
      } finally {
        wipe(raw);
      }
    },

    async unlock(opts) {
      const startedAt = epoch;
      const meta = await readMeta();
      if (!meta) return false;
      let raw: Bytes | null = null;
      try {
        raw = await unwrap(meta, opts);
        if (!raw || raw.length !== KEY_BYTES) return false;
        return await install(raw, startedAt);
      } catch (e) {
        // A wrong passphrase and a changed wrapped key look the same to AES-GCM: both fail cleanly.
        if (isDecryptFailure(e)) return false;
        if (e instanceof PasskeyError) {
          if (e.code === "cancelled") return false;
          throw new VaultError("passkey_unsupported", e.message);
        }
        throw e;
      } finally {
        wipe(raw);
      }
    },

    lock,

    isUnlocked() {
      if (keys && idle?.expired()) lock("idle");
      return keys !== null;
    },

    touch() {
      idle?.touch();
    },

    onLock(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async get<T>(name: string): Promise<T | undefined> {
      const k = current();
      const at = epoch;
      const slot = await slotFor(k.names, name);
      const box = await storage(() => store().get(slot));
      if (box === undefined) return undefined;
      if (!isBox(box)) throw new VaultError("damaged", "A saved item is damaged and cannot be read.");
      let plain: Bytes;
      try {
        plain = await openBytes(k.enc, box, RECORD + name);
      } catch {
        throw new VaultError("damaged", "A saved item was changed outside Tend, so it cannot be trusted or read.");
      }
      if (at !== epoch) throw new VaultError("locked", "Your saved work is locked. Open it to continue.");
      try {
        return JSON.parse(fromUtf8(plain)) as T;
      } finally {
        wipe(plain);
      }
    },

    async set<T>(name: string, value: T) {
      if (value === undefined) return vault.delete(name);
      const k = current();
      const slot = await slotFor(k.names, name);
      const box = await sealBytes(k.enc, utf8(JSON.stringify(value)), RECORD + name);
      await storage(() => store().put(slot, box));
    },

    async delete(name: string) {
      const k = current();
      const slot = await slotFor(k.names, name);
      await storage(() => store().delete(slot));
    },

    async destroy() {
      lock("destroyed");
      await storage(() => store().destroy());
    },
  };
  return vault;
}

// The app's vault. Nothing touches IndexedDB, WebAuthn, or the document until it is used.
export const vault: TendVault = createVault();
