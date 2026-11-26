import type { CityRestPayload } from "./city";
import type { CityGenPayload } from "./gen-worker";
import type { ParcelWorkerResponse } from "./parcel-worker";
import { WORLD_REV } from "./world-bin";

declare const __WORLD_BUILD_ID__: string;

const DB_NAME = "crazy-waymo-world";
const STORE = "world";
const KEY = "payload";

const buildId = () => {
  try {
    return __WORLD_BUILD_ID__;
  } catch {
    return "dev";
  }
};

const enabled = () => {
  if (globalThis.indexedDB === undefined) {
    return false;
  }

  if (!import.meta.env.DEV) {
    return true;
  }

  try {
    return new URLSearchParams(window.location.search).has("cache");
  } catch {
    return false;
  }
};

const settle = async <T>(req: IDBRequest<T>, failure: string) => {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  req.addEventListener("success", () => {
    resolve(req.result);
  });
  req.addEventListener("error", () => {
    reject(req.error ?? new Error(failure));
  });

  return await promise;
};

const complete: (tx: IDBTransaction) => Promise<void> = async (tx) => {
  const { promise, resolve, reject } = Promise.withResolvers<null>();
  tx.addEventListener("complete", () => {
    resolve(null);
  });
  tx.addEventListener("error", () => {
    reject(tx.error ?? new Error("idb write failed"));
  });

  await promise;
};

const openDb: () => Promise<IDBDatabase> = async () => {
  const req = indexedDB.open(DB_NAME, 1);
  req.addEventListener("upgradeneeded", () => {
    if (!req.result.objectStoreNames.contains(STORE)) {
      req.result.createObjectStore(STORE);
    }
  });

  return await settle(req, "idb open failed");
};

interface CacheEntries {
  payload: CityGenPayload;
  rest: CityRestPayload;
  parcels: ParcelWorkerResponse;
}

const readRecord = async <K extends keyof CacheEntries>(key: K, version: string) => {
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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion -- IndexedDB returns an untyped structured clone; only writeRecord fills this store, with CacheEntries[K] under key K, and the version check above ties it to this build
    return value.payload as CacheEntries[K];
  }

  return null;
};

const writeRecord = async <K extends keyof CacheEntries>(
  key: K,
  payload: CacheEntries[K],
  version: string,
) => {
  const db = await openDb();

  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ payload, version }, key);
    await complete(tx);
  } finally {
    db.close();
  }
};

export const readWorldCache = async () => {
  if (!enabled()) {
    return null;
  }

  try {
    const payload = await readRecord(KEY, buildId());

    if (payload !== null) {
      console.log("[world-cache] hit");
    }

    return payload;
  } catch {
    return null;
  }
};

export const readRestCache = async () => {
  if (!enabled()) {
    return null;
  }

  try {
    const payload = await readRecord("rest", buildId());

    if (payload !== null) {
      console.log("[world-cache] rest hit");
    }

    return payload;
  } catch {
    return null;
  }
};

const storeQuietly = async <K extends keyof CacheEntries>(
  key: K,
  payload: CacheEntries[K],
  version: string,
  label: string,
) => {
  try {
    await writeRecord(key, payload, version);
    console.log(`[world-cache] ${label}`);

    return true;
  } catch {
    return false;
  }
};

export const writeRestCache = (payload: CityRestPayload) => {
  if (!enabled()) {
    return;
  }

  void storeQuietly("rest", payload, buildId(), "rest stored");
};

export const writeWorldCache = (payload: CityGenPayload) => {
  if (!enabled()) {
    return;
  }

  void storeQuietly(KEY, payload, buildId(), "stored");
};

const PARCEL_KEY = "parcels";

const parcelVersion = (sourceBytes: number) => `${buildId()}|rev${WORLD_REV}|src${sourceBytes}`;

export const readParcelPlanCache = async (sourceBytes: number) => {
  if (!enabled()) {
    return null;
  }

  try {
    return await readRecord(PARCEL_KEY, parcelVersion(sourceBytes));
  } catch {
    return null;
  }
};

export const writeParcelPlanCache = (sourceBytes: number, payload: ParcelWorkerResponse) => {
  if (!enabled()) {
    return;
  }

  void storeQuietly(PARCEL_KEY, payload, parcelVersion(sourceBytes), "parcel plan stored");
};
