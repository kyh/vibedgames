import type { PackedWorldTile, WorldTileRef } from "./world-bin";

// The baked city arrives per 320u tile (shared/constants CHUNK), nearest
// first. A tile is fetched when it comes within the hold radius of the
// camera, installed by the city (merged meshes + parcel fabric) and evicted
// again once it falls well outside it, so the GPU and the heap carry the
// neighbourhood rather than the map. The title waits only for the tiles
// around the spawn (`ensure`); the rest keep streaming behind it.
//
// Tiles are immutable and served with a year of cache, so an evicted tile
// that comes back is a cache hit, not a download.

/** Fetches in flight at once. Installs are serialized — one build at a time
 *  keeps the frame budget predictable. */
const MAX_INFLIGHT = 3;
/** A resident tile is dropped this far past the hold radius, so a U-turn
 *  at the boundary does not thrash. */
const HYSTERESIS = 160;
/** Re-evaluate residency after the camera moves this far, or this often. */
const RESCAN_DIST = 24;
const RESCAN_MS = 1000;
/** A failed fetch is retried after this long. */
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

export const worldTileKey = (ix: number, iz: number): number => ix * 1024 + iz;

interface Slot {
  readonly ref: WorldTileRef;
  readonly key: number;
  state: "absent" | "loading" | "resident";
  /** Set while a fetch is in flight for a tile that has since fallen out of range. */
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

  stats(): TileStreamStats {
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

  /** Distance from (x, z) to the tile's nearest edge (0 inside it). */
  private edgeDistance(s: Slot, x: number, z: number): number {
    const dx = Math.max(0, Math.abs(s.ref.cx - x) - this.half);
    const dz = Math.max(0, Math.abs(s.ref.cz - z) - this.half);
    return Math.hypot(dx, dz);
  }

  /**
   * Hold every tile within `radius` of (x, z). Cheap to call every frame:
   * the scan runs only after the camera moves or time passes. Infinity holds
   * the whole map (editor show-all).
   */
  update(x: number, z: number, radius: number): void {
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
  ): Promise<void> {
    const wanted = this.slots.filter((s) => this.edgeDistance(s, x, z) < radius);
    const total = wanted.reduce((a, s) => a + s.ref.bytes, 0);
    this.view = { at: performance.now(), x, z };
    this.holdRadius = Math.max(this.holdRadius, radius);
    let attempts = 0;
    for (;;) {
      this.scan(x, z, Math.max(this.holdRadius, radius), Infinity, performance.now());
      const done = wanted.reduce((a, s) => a + (s.state === "resident" ? s.ref.bytes : 0), 0);
      onProgress?.(done, total);
      if (wanted.every((s) => s.state === "resident")) {
        return;
      }
      // A tile that failed keeps the title from ever showing: give up on it
      // after a couple of rounds — it streams in later if the network returns.
      if (wanted.every((s) => s.state !== "loading")) {
        attempts += 1;
        if (attempts > 2) {
          return;
        }
      }
      // oxlint-disable-next-line promise/avoid-new -- wraps the wake/timeout callback pair
      await new Promise<void>((resolve) => {
        this.waiters.add(resolve);
        setTimeout(() => {
          this.waiters.delete(resolve);
          resolve();
        }, RETRY_MS);
      });
    }
  }

  private wake(): void {
    for (const w of this.waiters) {
      w();
    }
    this.waiters.clear();
  }

  private scan(x: number, z: number, hold: number, drop: number, now: number): void {
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

  private load(slot: Slot): void {
    slot.state = "loading";
    slot.cancelled = false;
    this.inflight += 1;
    void this.loadAndDrain(slot);
  }

  private async loadAndDrain(slot: Slot): Promise<void> {
    try {
      await this.loadInto(slot);
    } finally {
      this.inflight -= 1;
      this.wake();
      // Keep the queue draining without waiting for the next camera move.
      const v = this.view;
      if (v) {
        this.scan(v.x, v.z, this.holdRadius, this.holdRadius + HYSTERESIS, performance.now());
      }
    }
  }

  private async loadInto(slot: Slot): Promise<void> {
    const fail = (what: string, message: string): void => {
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
    // Serialized: each install yields through the city's breathe(), and two
    // interleaved builds would double the per-frame cost.
    const previous = this.installing;
    const mine = (async (): Promise<void> => {
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
        // Fell out of range mid-install: undo it rather than leak a tile.
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
