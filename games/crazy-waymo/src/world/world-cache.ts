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
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  tx.addEventListener("complete", () => {
    resolve();
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

interface CacheRecord {
  payload: unknown;
  version: string;
}

const readRecord = async (key: string, version: string) => {
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

const writeRecord = async (key: string, record: CacheRecord) => {
  const db = await openDb();

  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record, key);
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
    const record = await readRecord(KEY, buildId());

    if (record) {
      console.log("[world-cache] hit");

      return record.payload as CityGenPayload;
    }

    return null;
  } catch {
    return null;
  }
};

export const readRestCache = async () => {
  if (!enabled()) {
    return null;
  }

  try {
    const record = await readRecord("rest", buildId());

    if (record) {
      console.log("[world-cache] rest hit");

      return record.payload as CityRestPayload;
    }

    return null;
  } catch {
    return null;
  }
};

const storeQuietly = async (key: string, record: CacheRecord, label: string) => {
  try {
    await writeRecord(key, record);
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

  void storeQuietly("rest", { payload, version: buildId() }, "rest stored");
};

export const writeWorldCache = (payload: CityGenPayload) => {
  if (!enabled()) {
    return;
  }

  void storeQuietly(KEY, { payload, version: buildId() }, "stored");
};

const PARCEL_KEY = "parcels";

const parcelVersion = (sourceBytes: number) => `${buildId()}|rev${WORLD_REV}|src${sourceBytes}`;

export const readParcelPlanCache = async (sourceBytes: number) => {
  if (!enabled()) {
    return null;
  }

  try {
    const record = await readRecord(PARCEL_KEY, parcelVersion(sourceBytes));

    if (record) {
      return record.payload as ParcelWorkerResponse;
    }

    return null;
  } catch {
    return null;
  }
};

export const writeParcelPlanCache = (sourceBytes: number, payload: ParcelWorkerResponse) => {
  if (!enabled()) {
    return;
  }

  void storeQuietly(
    PARCEL_KEY,
    { payload, version: parcelVersion(sourceBytes) },
    "parcel plan stored",
  );
};
