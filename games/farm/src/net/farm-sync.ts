import { MAP_H, MAP_W, PENDING_EDIT_MS } from "../config";
import { isJsonNumber, isJsonObject } from "../json";
import type { JsonObject, JsonValue } from "../json";
import { isClearable } from "../world/world";
import type { World, WorldObject } from "../world/world";
import {
  BARE_TILE,
  applyTileIntent,
  packTile,
  tileIdxOfKey,
  tileKey,
  tileValue,
  unpackTile,
  writeTile,
} from "./tile-codec";
import type { TileIntent, TileState } from "./tile-codec";

// The shared farm. The host owns it and writes it as flat primitive shared
// keys — `t<idx>` per farmed tile, `o<id>` per cleared tree, rock or mushroom
// (1 = gone) — so each change sends one small key. `w` is the host's world
// epoch: a new one means "this is my whole world", and guests adopt it whole
// (their own save's farm and felled trees give way to the host's). Guests act
// at once locally and send intents to the host; each such change is protected
// from older host values until the host echoes it or PENDING_EDIT_MS passes.

const TILE_COUNT = MAP_W * MAP_H;
const EPOCH_KEY = "w";
const OBJECT_KEY = /^o(?<id>\d+)$/u;

export const objectKey = (id: number): string => `o${id}`;

const objectIdOfKey = (key: string): number | null => {
  const digits = OBJECT_KEY.exec(key)?.groups?.id;
  return digits === undefined ? null : Number(digits);
};

/** A guest's clear request (`{ id }`), parsed at the wire boundary. */
export const parseClear = (payload: JsonValue): number | null => {
  if (!isJsonObject(payload)) {
    return null;
  }
  const { id } = payload;
  return isJsonNumber(id) && Number.isSafeInteger(id) && id >= 0 ? id : null;
};

/** Where the shared keys go: NetSession, or a test double. */
export interface SharedWriter {
  patchShared: (patch: JsonObject) => void;
}

/** The scene side of the sync: the live world and how to redraw it. */
export interface FarmView {
  world: () => World;
  /** A tile's state was rewritten under the scene. */
  redrawTile: (idx: number) => void;
  /** An object left the world under the scene. */
  objectGone: (o: WorldObject) => void;
  /** An object came back into the world under the scene. */
  objectBack: (o: WorldObject) => void;
}

/** Host: object `id` is gone from the farm. */
export const publishCleared = (net: SharedWriter, id: number): void => {
  net.patchShared({ [objectKey(id)]: 1 });
};

/** The host's state for a tile: a missing key is bare soil in its world. */
const hostTile = (shared: JsonObject | null, idx: number): Readonly<TileState> | null => {
  const raw = shared?.[tileKey(idx)];
  return raw === undefined ? BARE_TILE : unpackTile(raw);
};

interface PendingTile {
  value: number;
  until: number;
}

export class FarmSync {
  private readonly view: FarmView;
  private readonly generated: () => readonly WorldObject[];
  private clearables: readonly WorldObject[] | null = null;
  /** Guest: each shared key's value as last folded in. */
  private readonly seen = new Map<string, JsonValue>();
  private readonly pendingTiles = new Map<number, PendingTile>();
  private readonly pendingClears = new Map<number, number>();
  private epoch: number | null = null;

  /** `generated`: the co-op farm's objects as generated, before anyone cleared one
   *  (its trees, rocks and forage are what the `o<id>` keys can name). */
  constructor(view: FarmView, generated: () => readonly WorldObject[]) {
    this.view = view;
    this.generated = generated;
  }

  /** Forget the room — a new farm, a new scene start, a new role. */
  reset(): void {
    this.seen.clear();
    this.pendingTiles.clear();
    this.pendingClears.clear();
    this.epoch = null;
  }

  // ---- host ------------------------------------------------------------------

  /** Publish these tiles' current state (the SDK drops keys that didn't change). */
  publishTiles(net: SharedWriter, idxs: Iterable<number>): void {
    const world = this.view.world();
    const patch: JsonObject = {};
    let any = false;
    for (const idx of idxs) {
      patch[tileKey(idx)] = tileValue(world, idx);
      any = true;
    }
    if (any) {
      net.patchShared(patch);
    }
  }

  /**
   * A new host's first word: every farmed tile and every cleared object, plus
   * a correction for any key the room still holds that this world disagrees
   * with (an earlier host's farm), under a fresh epoch.
   */
  publishWorld(net: SharedWriter, shared: JsonObject | null, epoch: number): void {
    const world = this.view.world();
    const patch: JsonObject = { [EPOCH_KEY]: epoch };
    for (let idx = 0; idx < TILE_COUNT; idx += 1) {
      const key = tileKey(idx);
      const value = tileValue(world, idx);
      if (value !== 0 || shared?.[key] !== undefined) {
        patch[key] = value;
      }
    }
    const standing = new Set(world.objects.map((o) => o.id));
    for (const o of this.clearable()) {
      const key = objectKey(o.id);
      const gone = !standing.has(o.id);
      if (gone || shared?.[key] !== undefined) {
        patch[key] = gone ? 1 : 0;
      }
    }
    net.patchShared(patch);
  }

  /** Host: a guest's farming intent, where the world allows it. True when the tile changed. */
  applyIntent(intent: TileIntent): boolean {
    return applyTileIntent(this.view.world(), intent);
  }

  /** Host: a guest cleared object `id`. Returns it when it was still standing here. */
  clearObject(id: number): WorldObject | null {
    const world = this.view.world();
    const o = world.objects.find((c) => c.id === id);
    if (!o || !isClearable(o)) {
      return null;
    }
    world.removeObject(o);
    return o;
  }

  // ---- guest -----------------------------------------------------------------

  /** This farmer just changed tile `idx` and told the host. */
  protectTile(idx: number, now: number): void {
    this.pendingTiles.set(idx, {
      until: now + PENDING_EDIT_MS,
      value: tileValue(this.view.world(), idx),
    });
  }

  /** This farmer just cleared object `id` and told the host. */
  protectClear(id: number, now: number): void {
    this.pendingClears.set(id, now + PENDING_EDIT_MS);
  }

  /** Fold the host's shared state into the local world. Call when it changes. */
  adopt(shared: JsonObject, now: number): void {
    const epoch = shared[EPOCH_KEY];
    if (isJsonNumber(epoch) && epoch !== this.epoch) {
      this.epoch = epoch;
      this.adoptWhole(shared, now);
      return;
    }
    for (const [key, value] of Object.entries(shared)) {
      if (this.seen.get(key) === value) {
        continue;
      }
      this.seen.set(key, value);
      const idx = tileIdxOfKey(key);
      if (idx !== null) {
        this.applyTile(idx, unpackTile(value), now);
        continue;
      }
      const id = objectIdOfKey(key);
      if (id !== null) {
        this.applyObject(id, value === 1, now, this.standing(id));
      }
    }
  }

  /** Let protections lapse: a change the host never echoed settles to the
   *  host's value (it refused, or the intent was lost). Call every frame. */
  expire(shared: JsonObject | null, now: number): void {
    for (const [idx, pending] of this.pendingTiles) {
      if (now < pending.until) {
        continue;
      }
      this.pendingTiles.delete(idx);
      // Before the host's world arrives there is nothing to settle to.
      if (this.epoch !== null) {
        this.applyTile(idx, hostTile(shared, idx), now);
      }
    }
    for (const [id, until] of this.pendingClears) {
      if (now < until) {
        continue;
      }
      this.pendingClears.delete(id);
      if (this.epoch !== null) {
        this.applyObject(id, shared?.[objectKey(id)] === 1, now, this.standing(id));
      }
    }
  }

  private adoptWhole(shared: JsonObject, now: number): void {
    this.seen.clear();
    for (const [key, value] of Object.entries(shared)) {
      this.seen.set(key, value);
    }
    for (let idx = 0; idx < TILE_COUNT; idx += 1) {
      this.applyTile(idx, hostTile(shared, idx), now);
    }
    const standing = new Map(this.view.world().objects.map((o) => [o.id, o]));
    for (const o of this.clearable()) {
      this.applyObject(o.id, shared[objectKey(o.id)] === 1, now, standing.get(o.id));
    }
  }

  private applyTile(idx: number, host: Readonly<TileState> | null, now: number): void {
    if (!host) {
      return;
    }
    const value = packTile(host);
    const pending = this.pendingTiles.get(idx);
    if (pending) {
      // Not yet our change: an older host value must not undo it.
      if (pending.value !== value && now < pending.until) {
        return;
      }
      this.pendingTiles.delete(idx);
    }
    const world = this.view.world();
    if (tileValue(world, idx) !== value) {
      writeTile(world, idx, host);
      this.view.redrawTile(idx);
    }
  }

  private applyObject(
    id: number,
    gone: boolean,
    now: number,
    local: WorldObject | undefined,
  ): void {
    if (gone) {
      this.pendingClears.delete(id);
      if (local) {
        this.view.world().removeObject(local);
        this.view.objectGone(local);
      }
      return;
    }
    const until = this.pendingClears.get(id);
    if (until !== undefined && now < until) {
      return;
    }
    this.pendingClears.delete(id);
    const base = local ? undefined : this.clearable().find((o) => o.id === id);
    if (base) {
      const back = { ...base };
      this.view.world().restoreObject(back);
      this.view.objectBack(back);
    }
  }

  private standing(id: number): WorldObject | undefined {
    return this.view.world().objects.find((o) => o.id === id);
  }

  private clearable(): readonly WorldObject[] {
    this.clearables ??= this.generated().filter(isClearable);
    return this.clearables;
  }
}
