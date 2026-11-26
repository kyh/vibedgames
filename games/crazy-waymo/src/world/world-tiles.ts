import type { PackedWorldTile, WorldTileRef } from "./world-bin";

const MAX_INFLIGHT = 3;
const HYSTERESIS = 160;
const RESCAN_DIST = 24;
const RESCAN_MS = 1000;
const RETRY_MS = 5000;

export interface TileStreamHooks {
  readonly fetch: (ref: WorldTileRef) => Promise<PackedWorldTile | null>;
  readonly install: (key: number, tile: PackedWorldTile) => Promise<void>;
  readonly evict: (key: number) => void;
}

export interface TileStreamStats {
  readonly tiles: number;
  readonly resident: number;
  readonly loading: number;
  readonly residentBytes: number;
}

export const worldTileKey = (ix: number, iz: number) => ix * 1024 + iz;

interface Slot {
  readonly ref: WorldTileRef;
  readonly key: number;
  state: "absent" | "loading" | "resident";
  cancelled: boolean;
  retryAt: number;
}

export class WorldTileStreamer {
  private readonly slots: Slot[] = [];
  private readonly byKey = new Map<number, Slot>();
  private readonly half: number;
  private inflight = 0;
  private installing: Promise<void> = Promise.resolve();
  private view: { x: number; z: number; at: number } | null = null;
  private holdRadius = 0;
  private readonly waiters = new Set<() => void>();

  private readonly hooks: TileStreamHooks;

  constructor(refs: readonly WorldTileRef[], tileSize: number, hooks: TileStreamHooks) {
    this.hooks = hooks;
    this.half = tileSize / 2;

    for (const ref of refs) {
      const slot: Slot = {
        cancelled: false,
        key: worldTileKey(ref.ix, ref.iz),
        ref,
        retryAt: 0,
        state: "absent",
      };

      this.slots.push(slot);
      this.byKey.set(slot.key, slot);
    }
  }

  stats() {
    let resident = 0;
    let loading = 0;
    let residentBytes = 0;

    for (const s of this.slots) {
      if (s.state === "resident") {
        resident += 1;
        residentBytes += s.ref.bytes;
      } else if (s.state === "loading") {
        loading += 1;
      }
    }

    return { loading, resident, residentBytes, tiles: this.slots.length };
  }

  private edgeDistance(s: Slot, x: number, z: number) {
    const dx = Math.max(0, Math.abs(s.ref.cx - x) - this.half);
    const dz = Math.max(0, Math.abs(s.ref.cz - z) - this.half);

    return Math.hypot(dx, dz);
  }

  /**
   * Hold every tile within `radius` of (x, z). Cheap to call every frame:
   * the scan runs only after the camera moves or time passes. Infinity holds
   * the whole map (editor show-all).
   */
  update(x: number, z: number, radius: number) {
    const now = performance.now();
    const v = this.view;

    if (
      v &&
      radius === this.holdRadius &&
      Math.hypot(x - v.x, z - v.z) < RESCAN_DIST &&
      now - v.at < RESCAN_MS
    ) {
      return;
    }

    this.view = { at: now, x, z };
    this.holdRadius = radius;
    this.scan(x, z, radius, radius + HYSTERESIS, now);
  }

  /**
   * Resolve once every tile within `radius` of (x, z) is installed (or has
   * failed twice). Progress reports gzipped bytes installed over bytes wanted.
   */
  async ensure(
    x: number,
    z: number,
    radius: number,
    onProgress?: (done: number, total: number) => void,
  ) {
    const wanted = this.slots.filter((s) => this.edgeDistance(s, x, z) < radius);
    const total = wanted.reduce((a, s) => a + s.ref.bytes, 0);
    this.view = { at: performance.now(), x, z };
    this.holdRadius = Math.max(this.holdRadius, radius);
    let attempts = 0;

    const poll: () => Promise<void> = async () => {
      this.scan(x, z, Math.max(this.holdRadius, radius), Infinity, performance.now());
      const done = wanted.reduce((a, s) => a + (s.state === "resident" ? s.ref.bytes : 0), 0);
      onProgress?.(done, total);

      if (wanted.every((s) => s.state === "resident")) {
        return;
      }

      if (wanted.every((s) => s.state !== "loading")) {
        attempts += 1;

        if (attempts > 2) {
          return;
        }
      }

      const { promise, resolve } = Promise.withResolvers<null>();

      const release = () => {
        resolve(null);
      };

      this.waiters.add(release);
      setTimeout(() => {
        this.waiters.delete(release);
        release();
      }, RETRY_MS);

      await promise;
      await poll();
    };

    await poll();
  }

  private wake() {
    for (const w of this.waiters) {
      w();
    }

    this.waiters.clear();
  }

  private scan(x: number, z: number, hold: number, drop: number, now: number) {
    const queue: { slot: Slot; d: number }[] = [];

    for (const s of this.slots) {
      const d = this.edgeDistance(s, x, z);

      if (s.state === "resident") {
        if (d > drop) {
          s.state = "absent";
          this.hooks.evict(s.key);
        }
      } else if (s.state === "loading") {
        s.cancelled = d > drop;
      } else if (d < hold && now >= s.retryAt) {
        queue.push({ d, slot: s });
      }
    }

    queue.sort((a, b) => a.d - b.d);

    for (const { slot } of queue) {
      if (this.inflight >= MAX_INFLIGHT) {
        break;
      }

      this.load(slot);
    }
  }

  private load(slot: Slot) {
    slot.state = "loading";
    slot.cancelled = false;
    this.inflight += 1;
    void this.loadAndDrain(slot);
  }

  private async loadAndDrain(slot: Slot) {
    try {
      await this.loadInto(slot);
    } finally {
      this.inflight -= 1;
      this.wake();
      const v = this.view;

      if (v) {
        this.scan(v.x, v.z, this.holdRadius, this.holdRadius + HYSTERESIS, performance.now());
      }
    }
  }

  private async loadInto(slot: Slot) {
    const fail = (what: string, message: string) => {
      console.log(`[world-tiles] ${what} ${slot.ref.ix},${slot.ref.iz}: ${message}`);
      slot.state = "absent";
      slot.retryAt = performance.now() + RETRY_MS;
    };

    let tile: PackedWorldTile | null = null;

    try {
      tile = await this.hooks.fetch(slot.ref);
    } catch (error) {
      fail("fetch", error instanceof Error ? error.message : String(error));

      return;
    }

    if (!tile) {
      fail("fetch", "no tile");

      return;
    }

    if (slot.cancelled) {
      slot.state = "absent";

      return;
    }

    const previous = this.installing;

    const mine = (async () => {
      await previous;

      if (slot.cancelled) {
        slot.state = "absent";

        return;
      }

      try {
        await this.hooks.install(slot.key, tile);
      } catch (error) {
        this.hooks.evict(slot.key);
        fail("install", error instanceof Error ? error.message : String(error));

        return;
      }

      if (slot.cancelled) {
        this.hooks.evict(slot.key);
        slot.state = "absent";

        return;
      }

      slot.state = "resident";
    })();

    this.installing = mine;
    await mine;
  }
}
