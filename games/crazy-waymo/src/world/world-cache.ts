import type { CityRestPayload } from "./city";
import type { CityGenPayload } from "./gen-worker";
import type { ParcelWorkerResponse } from "./parcel-worker";
import { WORLD_REV } from "./world-bin";

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

const enabled = (): boolean => {
  if (globalThis.indexedDB === undefined) {
    return false;
  }
  if (!import.meta.env.DEV) {
    return true;
  }
  // Dev default: bypass (stale worlds while editing gen code). ?cache=1 opts
  // in so the cache path is debuggable with dev hooks available.
  try {
    return new URLSearchParams(window.location.search).has("cache");
  } catch {
    return false;
  }
};

// IndexedDB is a callback API: the request/transaction wrappers below are the
// only places that build promises by hand.
const settle = <T>(req: IDBRequest<T>, failure: string): Promise<T> =>
  // oxlint-disable-next-line promise/avoid-new -- wraps the IDBRequest callback API
  new Promise((resolve, reject) => {
    req.addEventListener("success", () => resolve(req.result));
    req.addEventListener("error", () => reject(req.error ?? new Error(failure)));
  });

const complete = (tx: IDBTransaction): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- wraps the IDBTransaction callback API
  new Promise((resolve, reject) => {
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("error", () => reject(tx.error ?? new Error("idb write failed")));
  });

const openDb = (): Promise<IDBDatabase> => {
  const req = indexedDB.open(DB_NAME, 1);
  req.addEventListener("upgradeneeded", () => {
    if (!req.result.objectStoreNames.contains(STORE)) {
      req.result.createObjectStore(STORE);
    }
  });
  return settle(req, "idb open failed");
};

// Every record is a versioned envelope; the payload is only handed back once
// the stored version matches the one this build would have written.
interface CacheRecord {
  payload: unknown;
  version: string;
}

const readRecord = async (key: string, version: string): Promise<CacheRecord | null> => {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const value: unknown = await settle(tx.objectStore(STORE).get(key), "idb read failed");
  db.close();
  if (
    value instanceof Object &&
    "version" in value &&
    "payload" in value &&
    value.version === version
  ) {
    return { payload: value.payload, version };
  }
  return null;
};

const writeRecord = async (key: string, record: CacheRecord): Promise<void> => {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record, key);
    await complete(tx);
  } finally {
    db.close();
  }
};

export const readWorldCache = async (): Promise<CityGenPayload | null> => {
  if (!enabled()) {
    return null;
  }
  try {
    const record = await readRecord(KEY, buildId());
    if (record) {
      console.log("[world-cache] hit");
      // SAFETY: the version matched this build, so the record is the structured
      // clone writeWorldCache stored — its payload is a CityGenPayload.
      return record.payload as CityGenPayload;
    }
    return null;
  } catch {
    return null;
  }
};

export const readRestCache = async (): Promise<CityRestPayload | null> => {
  if (!enabled()) {
    return null;
  }
  try {
    const record = await readRecord("rest", buildId());
    if (record) {
      console.log("[world-cache] rest hit");
      // SAFETY: the version matched this build, so the record is the structured
      // clone writeRestCache stored — its payload is a CityRestPayload.
      return record.payload as CityRestPayload;
    }
    return null;
  } catch {
    return null;
  }
};

// Fire-and-forget: a failed write just means the next visit regenerates.
const storeQuietly = async (key: string, record: CacheRecord, label: string): Promise<void> => {
  try {
    await writeRecord(key, record);
    console.log(`[world-cache] ${label}`);
  } catch {
    // best effort
  }
};

export const writeRestCache = (payload: CityRestPayload): void => {
  if (!enabled()) {
    return;
  }
  void storeQuietly("rest", { payload, version: buildId() }, "rest stored");
};

export const writeWorldCache = (payload: CityGenPayload): void => {
  if (!enabled()) {
    return;
  }
  void storeQuietly(KEY, { payload, version: buildId() }, "stored");
};

// --- The parcel plan -----------------------------------------------------------
// The worker's plan for the whole city (parcel-worker.ts), so a revisit skips
// the ~5 s it takes. Keyed like the rest cache — every deploy replans — and by
// the source bytes and world rev, since the plan is a function of both.
const PARCEL_KEY = "parcels";

const parcelVersion = (sourceBytes: number): string =>
  `${buildId()}|rev${WORLD_REV}|src${sourceBytes}`;

export const readParcelPlanCache = async (
  sourceBytes: number,
): Promise<ParcelWorkerResponse | null> => {
  if (!enabled()) {
    return null;
  }
  try {
    const record = await readRecord(PARCEL_KEY, parcelVersion(sourceBytes));
    if (record) {
      // SAFETY: the only writer of this key is writeParcelPlanCache below, and
      // the version string it stamps has just been matched.
      return record.payload as ParcelWorkerResponse;
    }
    return null;
  } catch {
    return null;
  }
};

export const writeParcelPlanCache = (sourceBytes: number, payload: ParcelWorkerResponse): void => {
  if (!enabled()) {
    return;
  }
  void storeQuietly(
    PARCEL_KEY,
    { payload, version: parcelVersion(sourceBytes) },
    "parcel plan stored",
  );
};
