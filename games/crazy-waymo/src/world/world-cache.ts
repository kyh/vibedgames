import type { CityGenPayload } from "./gen-worker";

// IndexedDB cache for the worker-generated world: first visit pays the ~5-8s
// generation once, every later visit loads the finished buffers in a few
// hundred ms. Keyed by build id — each deploy regenerates. Dev bypasses the
// cache entirely (stale worlds while editing gen code would be maddening).

declare const __WORLD_BUILD_ID__: string;

const DB_NAME = "crazy-waymo-world";
const STORE = "world";
const KEY = "payload";

const buildId = (): string => {
  try {
    return __WORLD_BUILD_ID__;
  } catch {
    return "dev";
  }
};

const enabled = (): boolean => !import.meta.env.DEV && typeof indexedDB !== "undefined";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("idb open failed"));
  });
}

export async function readWorldCache(): Promise<CityGenPayload | null> {
  if (!enabled()) return null;
  try {
    const db = await openDb();
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("idb read failed"));
    });
    db.close();
    if (
      value &&
      typeof value === "object" &&
      "version" in value &&
      "payload" in value &&
      (value as { version: unknown }).version === buildId()
    ) {
      console.log("[world-cache] hit");
      return (value as { payload: CityGenPayload }).payload;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeWorldCache(payload: CityGenPayload): void {
  if (!enabled()) return;
  // Fire-and-forget: a failed write just means the next visit regenerates.
  void openDb()
    .then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put({ version: buildId(), payload }, KEY);
          tx.oncomplete = () => {
            db.close();
            console.log("[world-cache] stored");
            resolve();
          };
          tx.onerror = () => reject(tx.error ?? new Error("idb write failed"));
        }),
    )
    .catch(() => {});
}
