// lib/vault: AES-256-GCM records under a key from a passphrase (PBKDF2-SHA-256) or a passkey
// (WebAuthn PRF), held only in memory. docs/PRIVACY.md "Storage between sessions".
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVault,
  memoryStore,
  PasskeyError,
  PBKDF2_ITERATIONS,
  VaultError,
  type LockReason,
  type PasskeyProvider,
} from "@/lib/vault";
import { idbStore } from "@/lib/vault/store";
import { fakeIndexedDB } from "./trust-helpers";

// Fast rounds for most tests; one test runs the real 600,000.
const FAST = 1_000;
const SECRET = { note: "counseling receipts from June", amounts: [4000, 4000], ok: true, word: "café" };

function fakePasskeys(seed = "authenticator-1", mode: "ok" | "cancel" | "unsupported" = "ok"): PasskeyProvider {
  // PRF semantics: HMAC(device secret, salt). A different device gives a different secret.
  const prf = (salt: Uint8Array) =>
    new Uint8Array(createHmac("sha256", seed).update(salt).digest()) as Uint8Array<ArrayBuffer>;
  return {
    available: async () => mode !== "unsupported",
    async register(salt) {
      if (mode === "cancel") throw new PasskeyError("cancelled", "no");
      if (mode === "unsupported") throw new PasskeyError("unsupported", "no prf");
      return { credentialId: "cred-1", secret: prf(salt) };
    },
    async secret(_id, salt) {
      if (mode === "cancel") throw new PasskeyError("cancelled", "no");
      if (mode === "unsupported") throw new PasskeyError("unsupported", "no prf");
      return prf(salt);
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("vault with a passphrase", () => {
  it("round-trips records and keeps only ciphertext in storage", async () => {
    const store = memoryStore();
    const vault = createVault({ store, iterations: FAST, idleMs: 0 });
    expect(await vault.exists()).toBe(false);
    await vault.create({ passphrase: "maple river 42" });
    expect(vault.isUnlocked()).toBe(true);
    await vault.set("answers", SECRET);
    await vault.set("count", 3);
    expect(await vault.get("answers")).toEqual(SECRET);
    expect(await vault.get("count")).toBe(3);
    expect(await vault.get("missing")).toBeUndefined();

    const disk = JSON.stringify([...store.records]);
    for (const plain of ["counseling receipts", "café", "maple river", "answers", "4000"]) {
      expect(disk).not.toContain(plain);
    }
    expect(await vault.methods()).toEqual({ passphrase: true, passkey: false });
  });

  it("uses PBKDF2 with 600,000 iterations and a random salt by default", async () => {
    const a = memoryStore();
    const b = memoryStore();
    await createVault({ store: a, idleMs: 0 }).create({ passphrase: "same words here" });
    await createVault({ store: b, iterations: FAST, idleMs: 0 }).create({ passphrase: "same words here" });
    const meta = a.records.get("meta") as { pass: { iterations: number; salt: string } };
    expect(PBKDF2_ITERATIONS).toBe(600_000);
    expect(meta.pass.iterations).toBe(600_000);
    expect(meta.pass.salt).not.toBe((b.records.get("meta") as { pass: { salt: string } }).pass.salt);
    // A reloaded page with the real count still opens it.
    const again = createVault({ store: a, idleMs: 0 });
    expect(await again.unlock({ passphrase: "same words here" })).toBe(true);
  }, 20_000);

  it("opens after a reload with the right passphrase and refuses a wrong one cleanly", async () => {
    const store = memoryStore();
    const first = createVault({ store, iterations: FAST, idleMs: 0 });
    await first.create({ passphrase: "maple river 42" });
    await first.set("answers", SECRET);

    const reloaded = createVault({ store, iterations: FAST, idleMs: 0 });
    expect(reloaded.isUnlocked()).toBe(false);
    await expect(reloaded.get("answers")).rejects.toMatchObject({ code: "locked" });
    expect(await reloaded.unlock({ passphrase: "maple river 43" })).toBe(false);
    expect(await reloaded.unlock({ passphrase: "" })).toBe(false);
    expect(reloaded.isUnlocked()).toBe(false);
    expect(await reloaded.unlock({ passphrase: "maple river 42" })).toBe(true);
    expect(await reloaded.get("answers")).toEqual(SECRET);
  });

  it("treats the same passphrase typed with different Unicode forms as the same", async () => {
    const store = memoryStore();
    await createVault({ store, iterations: FAST, idleMs: 0 }).create({ passphrase: "café au lait" });
    const v = createVault({ store, iterations: FAST, idleMs: 0 });
    expect(await v.unlock({ passphrase: "café au lait" })).toBe(true);
  });

  it("lock() drops the key; nothing can be read or written until it is opened again", async () => {
    const vault = createVault({ store: memoryStore(), iterations: FAST, idleMs: 0 });
    const reasons: LockReason[] = [];
    vault.onLock((r) => reasons.push(r));
    await vault.create({ passphrase: "maple river 42" });
    await vault.set("answers", SECRET);
    vault.lock();
    expect(vault.isUnlocked()).toBe(false);
    await expect(vault.get("answers")).rejects.toBeInstanceOf(VaultError);
    await expect(vault.set("answers", 1)).rejects.toMatchObject({ code: "locked" });
    expect(reasons).toEqual(["manual"]);
    expect(await vault.unlock({ passphrase: "maple river 42" })).toBe(true);
    expect(await vault.get("answers")).toEqual(SECRET);
  });

  it("detects a changed record, a swapped record, and a changed wrapped key", async () => {
    const store = memoryStore();
    const vault = createVault({ store, iterations: FAST, idleMs: 0 });
    await vault.create({ passphrase: "maple river 42" });
    await vault.set("a", { value: "first" });
    await vault.set("b", { value: "second" });
    const slots = [...store.records.keys()].filter((k) => k.startsWith("r:"));
    expect(slots).toHaveLength(2);

    // One flipped bit in the ciphertext.
    const [slotA, slotB] = slots;
    const boxA = store.records.get(slotA) as { iv: string; ct: string };
    const boxB = store.records.get(slotB) as { iv: string; ct: string };
    const flip = (s: string) => (s[5] === "A" ? `${s.slice(0, 5)}B${s.slice(6)}` : `${s.slice(0, 5)}A${s.slice(6)}`);
    store.records.set(slotA, { ...boxA, ct: flip(boxA.ct) });
    const results = await Promise.allSettled([vault.get("a"), vault.get("b")]);
    const damaged = results.filter((r) => r.status === "rejected");
    expect(damaged).toHaveLength(1);
    expect((damaged[0] as PromiseRejectedResult).reason).toMatchObject({ code: "damaged" });

    // Each record is bound to its name: moving one box into another's slot fails too.
    store.records.set(slotA, boxB);
    store.records.set(slotB, boxA);
    await expect(vault.get("a")).rejects.toMatchObject({ code: "damaged" });
    await expect(vault.get("b")).rejects.toMatchObject({ code: "damaged" });

    // A changed wrapped key reads as a wrong passphrase: unlock fails cleanly.
    const meta = store.records.get("meta") as { pass: { box: { iv: string; ct: string } } };
    store.records.set("meta", {
      ...meta,
      pass: { ...meta.pass, box: { ...meta.pass.box, ct: flip(meta.pass.box.ct) } },
    });
    const fresh = createVault({ store, iterations: FAST, idleMs: 0 });
    expect(await fresh.unlock({ passphrase: "maple river 42" })).toBe(false);
  });

  it("refuses short passphrases, no method, and a second vault on the same device", async () => {
    const vault = createVault({ store: memoryStore(), iterations: FAST, idleMs: 0 });
    await expect(vault.create({ passphrase: "12345" })).rejects.toMatchObject({ code: "weak_passphrase" });
    await expect(vault.create({})).rejects.toMatchObject({ code: "no_method" });
    await vault.create({ passphrase: "123456" });
    await expect(vault.create({ passphrase: "another one" })).rejects.toMatchObject({ code: "exists" });
  });

  it("destroy() deletes the database and locks", async () => {
    const store = memoryStore();
    const vault = createVault({ store, iterations: FAST, idleMs: 0 });
    const reasons: LockReason[] = [];
    vault.onLock((r) => reasons.push(r));
    await vault.create({ passphrase: "maple river 42" });
    await vault.set("answers", SECRET);
    await vault.destroy();
    expect(store.records.size).toBe(0);
    expect(await vault.exists()).toBe(false);
    expect(vault.isUnlocked()).toBe(false);
    expect(reasons).toEqual(["destroyed"]);
    expect(await vault.unlock({ passphrase: "maple river 42" })).toBe(false);
  });

  it("a lock that lands while unlock is still deriving the key wins", async () => {
    const store = memoryStore();
    await createVault({ store, iterations: FAST, idleMs: 0 }).create({ passphrase: "maple river 42" });
    const vault = createVault({ store, iterations: FAST, idleMs: 0 });
    const pending = vault.unlock({ passphrase: "maple river 42" });
    vault.lock(); // Exit pressed mid-unlock
    expect(await pending).toBe(false);
    expect(vault.isUnlocked()).toBe(false);
  });
});

describe("auto-lock after inactivity", () => {
  it("locks after the idle time, and taps or keys push it back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const activity = new EventTarget();
    const vault = createVault({ store: memoryStore(), iterations: FAST, idleMs: 60_000, activity });
    const reasons: LockReason[] = [];
    vault.onLock((r) => reasons.push(r));
    await vault.create({ passphrase: "maple river 42" });

    await vi.advanceTimersByTimeAsync(50_000);
    expect(vault.isUnlocked()).toBe(true);
    activity.dispatchEvent(new Event("keydown"));
    await vi.advanceTimersByTimeAsync(50_000);
    expect(vault.isUnlocked()).toBe(true);
    // Saving in the background is not activity.
    await vault.set("draft", { step: 2 });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(vault.isUnlocked()).toBe(false);
    expect(reasons).toEqual(["idle"]);
    await expect(vault.get("draft")).rejects.toMatchObject({ code: "locked" });
  });

  it("locks when the page is left, so the back cache cannot restore it open", async () => {
    const exit = new EventTarget();
    const vault = createVault({ store: memoryStore(), iterations: FAST, idleMs: 0, exit });
    const reasons: LockReason[] = [];
    vault.onLock((r) => reasons.push(r));
    await vault.create({ passphrase: "maple river 42" });
    exit.dispatchEvent(new Event("pagehide"));
    expect(vault.isUnlocked()).toBe(false);
    expect(reasons).toEqual(["exit"]);
    // Opened again later, it listens again; a manual lock stops listening.
    expect(await vault.unlock({ passphrase: "maple river 42" })).toBe(true);
    vault.lock();
    exit.dispatchEvent(new Event("pagehide"));
    expect(reasons).toEqual(["exit", "manual"]);
  });

  it("locks on the next use when a sleeping tab missed its timer", async () => {
    let now = 1_000_000;
    const vault = createVault({
      store: memoryStore(),
      iterations: FAST,
      idleMs: 60_000,
      activity: null,
      now: () => now,
    });
    await vault.create({ passphrase: "maple river 42" });
    now += 61_000; // timers do not run in a background tab
    await expect(vault.get("anything")).rejects.toMatchObject({ code: "locked" });
    expect(vault.isUnlocked()).toBe(false);
  });
});

describe("vault with a passkey (WebAuthn PRF)", () => {
  it("creates and opens with the passkey's PRF secret", async () => {
    const store = memoryStore();
    const vault = createVault({ store, passkeys: fakePasskeys(), idleMs: 0 });
    await vault.create({ passkey: true });
    await vault.set("answers", SECRET);
    vault.lock();
    expect(await vault.unlock({ passkey: true })).toBe(true);
    expect(await vault.get("answers")).toEqual(SECRET);
    expect(await vault.methods()).toEqual({ passphrase: false, passkey: true });
    const meta = store.records.get("meta") as { key: { id: string; salt: string } };
    expect(meta.key.id).toBe("cred-1");
  });

  it("fails cleanly with another device's passkey or a cancelled prompt", async () => {
    const store = memoryStore();
    await createVault({ store, passkeys: fakePasskeys(), idleMs: 0 }).create({ passkey: true });
    expect(
      await createVault({ store, passkeys: fakePasskeys("authenticator-2"), idleMs: 0 }).unlock({ passkey: true }),
    ).toBe(false);
    expect(
      await createVault({ store, passkeys: fakePasskeys("x", "cancel"), idleMs: 0 }).unlock({ passkey: true }),
    ).toBe(false);
    await expect(
      createVault({ store, passkeys: fakePasskeys("x", "unsupported"), idleMs: 0 }).unlock({ passkey: true }),
    ).rejects.toMatchObject({ code: "passkey_unsupported" });
  });

  it("writes nothing when the passkey cannot be made", async () => {
    const store = memoryStore();
    const vault = createVault({ store, passkeys: fakePasskeys("x", "unsupported"), idleMs: 0 });
    await expect(vault.create({ passkey: true, passphrase: "maple river 42" })).rejects.toMatchObject({
      code: "passkey_unsupported",
    });
    expect(store.records.size).toBe(0);
    await expect(
      createVault({ store, passkeys: fakePasskeys("x", "cancel"), idleMs: 0 }).create({ passkey: true }),
    ).rejects.toMatchObject({
      code: "passkey_cancelled",
    });
  });

  it("opens with either the passkey or the backup passphrase", async () => {
    const store = memoryStore();
    const vault = createVault({ store, passkeys: fakePasskeys(), iterations: FAST, idleMs: 0 });
    await vault.create({ passkey: true, passphrase: "maple river 42" });
    await vault.set("answers", SECRET);
    const byKey = createVault({ store, passkeys: fakePasskeys(), idleMs: 0 });
    expect(await byKey.unlock({ passkey: true })).toBe(true);
    expect(await byKey.get("answers")).toEqual(SECRET);
    const byWords = createVault({ store, idleMs: 0 });
    expect(await byWords.unlock({ passphrase: "maple river 42" })).toBe(true);
    expect(await byWords.get("answers")).toEqual(SECRET);
  });
});

describe("IndexedDB store", () => {
  it("keeps boxes across connections and deletes the database on destroy", async () => {
    const idb = fakeIndexedDB();
    const vault = createVault({ store: idbStore("tend-vault", () => idb.factory), iterations: FAST, idleMs: 0 });
    await vault.create({ passphrase: "maple river 42" });
    await vault.set("answers", SECRET);
    expect(idb.databases()).toEqual(["tend-vault"]);

    const reopened = createVault({ store: idbStore("tend-vault", () => idb.factory), iterations: FAST, idleMs: 0 });
    expect(await reopened.exists()).toBe(true);
    expect(await reopened.unlock({ passphrase: "maple river 42" })).toBe(true);
    expect(await reopened.get("answers")).toEqual(SECRET);

    await reopened.destroy();
    expect(idb.databases()).toEqual([]);
    expect(await createVault({ store: idbStore("tend-vault", () => idb.factory), idleMs: 0 }).exists()).toBe(false);
  });

  it("never creates the database just by looking, so a deleted vault leaves no trace", async () => {
    const idb = fakeIndexedDB();
    const vault = createVault({ store: idbStore("tend-vault", () => idb.factory), iterations: FAST, idleMs: 0 });
    expect(await vault.exists()).toBe(false);
    expect(await vault.methods()).toBeNull();
    expect(await vault.unlock({ passphrase: "maple river 42" })).toBe(false);
    expect(idb.databases()).toEqual([]);

    await vault.create({ passphrase: "maple river 42" });
    expect(idb.databases()).toEqual(["tend-vault"]);
    await vault.destroy();
    expect(await vault.exists()).toBe(false);
    expect(idb.databases()).toEqual([]);
  });

  it("says so plainly when the browser has no storage", async () => {
    const vault = createVault({ store: idbStore("tend-vault", () => undefined), idleMs: 0 });
    await expect(vault.exists()).rejects.toMatchObject({ code: "storage" });
  });
});
