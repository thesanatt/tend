// Where the vault keeps its boxes. The browser default is IndexedDB; tests use the memory store.
// A store only ever sees ciphertext, salts, and a passkey's credential id.

export interface VaultStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  // Removes every record and the database itself.
  destroy(): Promise<void>;
}

export class StorageUnavailableError extends Error {
  constructor() {
    super("This browser cannot save anything on this device.");
    this.name = "StorageUnavailableError";
  }
}

const OBJECTS = "kv";

export function idbStore(dbName = "tend-vault", factory?: () => IDBFactory | undefined): VaultStore {
  // Only ever a real, open connection.
  let conn: Promise<IDBDatabase> | null = null;

  const idb = (): IDBFactory => {
    const f = factory ? factory() : globalThis.indexedDB;
    if (!f) throw new StorageUnavailableError();
    return f;
  };

  // Reading never creates the database. On a shared device, even an empty "tend-vault" left
  // behind after a check (or after delete) would show that Tend was used here.
  function connect(create: boolean): Promise<IDBDatabase | null> {
    if (conn) return conn;
    const attempt = new Promise<IDBDatabase | null>((resolve, reject) => {
      const req = idb().open(dbName, 1);
      let skipped = false;
      req.onupgradeneeded = (ev) => {
        if (!create && ev.oldVersion === 0) {
          // Aborting the first upgrade of a brand-new database removes it again.
          skipped = true;
          req.transaction?.abort();
          return;
        }
        if (!req.result.objectStoreNames.contains(OBJECTS)) req.result.createObjectStore(OBJECTS);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = (ev) => {
        if (!skipped) return reject(req.error ?? new StorageUnavailableError());
        ev.preventDefault();
        resolve(null);
      };
    });
    return attempt.then((db) => {
      if (!db) return null;
      // Two calls raced to connect: keep one connection, so nothing blocks a later delete.
      if (conn) {
        db.close();
        return conn;
      }
      // Another tab deleting the vault asks open connections to close; this one does.
      db.onversionchange = () => {
        db.close();
        conn = null;
      };
      db.onclose = () => {
        conn = null;
      };
      conn = Promise.resolve(db);
      return db;
    });
  }

  async function run<T>(
    mode: IDBTransactionMode,
    op: (s: IDBObjectStore) => IDBRequest<T>,
    create = false,
  ): Promise<T | undefined> {
    const db = await connect(create);
    // No database yet: nothing to read, delete, or clear.
    if (!db) return undefined;
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(OBJECTS, mode);
      const req = op(tx.objectStore(OBJECTS));
      // Resolve on commit, so a write is on disk before the caller moves on.
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? req.error);
      tx.onabort = () => reject(tx.error ?? new Error("The save was cancelled."));
    });
  }

  return {
    get: (key) => run("readonly", (s) => s.get(key)),
    async put(key, value) {
      await run("readwrite", (s) => s.put(value, key), true);
    },
    async delete(key) {
      await run("readwrite", (s) => s.delete(key));
    },
    async destroy() {
      // Clear first: if another tab blocks the delete, nothing readable is left meanwhile.
      try {
        await run("readwrite", (s) => s.clear());
      } catch {
        // an unopenable database still gets the delete below
      }
      const db = conn ? await conn.catch(() => null) : null;
      db?.close();
      conn = null;
      await new Promise<void>((resolve, reject) => {
        const req = idb().deleteDatabase(dbName);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        // Blocked by a tab that has not closed yet: the records are already gone, and the delete
        // finishes on its own once that tab lets go.
        req.onblocked = () => resolve();
      });
    },
  };
}

export function memoryStore(): VaultStore & { records: Map<string, unknown> } {
  const records = new Map<string, unknown>();
  return {
    records,
    async get(key) {
      const v = records.get(key);
      return v === undefined ? undefined : structuredClone(v);
    },
    async put(key, value) {
      records.set(key, structuredClone(value));
    },
    async delete(key) {
      records.delete(key);
    },
    async destroy() {
      records.clear();
    },
  };
}
