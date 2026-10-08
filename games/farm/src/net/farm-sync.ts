import { MAP_H, MAP_W, PENDING_EDIT_MS } from "../config";
import { isJsonNumber } from "../json";
import type { JsonObject, JsonValue } from "../json";
import { isClearable } from "../world/world";
import type { World, WorldObject } from "../world/world";
import {
  BARE_TILE,
  applyTileIntent,
  harvestTile,
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
// (1 = gone) — so each change sends one small key. `w` is the farm's epoch:
// one farm keeps it through host changes and mine trips, and a farm the room
// hasn't seen (a new or loaded one) is published under a new one, which
// guests adopt whole (their own save's farm and felled trees give way) and
// which retires the old farm's claims. Guests act at once locally — tilling
// and watering through intents to the host, contested actions through claims
// (net/claims) — and each such change is protected from older host values
// until the host echoes it or PENDING_EDIT_MS passes.

const TILE_COUNT = MAP_W * MAP_H;
const EPOCH_KEY = "w";
const OBJECT_KEY = /^o(?<id>\d+)$/u;

export const objectKey = (id: number): string => `o${id}`;

const objectIdOfKey = (key: string): number | null => {
  const digits = OBJECT_KEY.exec(key)?.groups?.id;
  return digits === undefined ? null : Number(digits);
};

/** The farm epoch a room's shared state names, or null before any farm. */
export const roomEpoch = (shared: JsonObject | null): number | null => {
  const epoch = shared?.[EPOCH_KEY];
  return isJsonNumber(epoch) ? epoch : null;
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
const publishCleared = (net: SharedWriter, id: number): void => {
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
  /** The epoch this farm was published under (host) or adopted from (guest);
   *  null for a farm the room hasn't seen. */
  private farmEpoch: number | null = null;
  /** Guest: the next adopt takes the host's farm whole, whatever its epoch. */
  private adoptWholeNext = true;

  /** `generated`: the co-op farm's objects as generated, before anyone cleared one
   *  (its trees, rocks and forage are what the `o<id>` keys can name). */
  constructor(view: FarmView, generated: () => readonly WorldObject[]) {
    this.view = view;
    this.generated = generated;
  }

  /** The farm's epoch in the room — what its claim keys carry — or null
   *  before the room has seen this farm. */
  get epoch(): number | null {
    return this.farmEpoch;
  }

  /** A new scene start on the same farm: a guest takes the host's farm whole
   *  again on its next adopt; the farm keeps its epoch, so a host back from
   *  the mine republishes under it and its claims stay good. */
  reset(): void {
    this.seen.clear();
    this.pendingTiles.clear();
    this.pendingClears.clear();
    this.adoptWholeNext = true;
  }

  /** A different farm (a new or loaded one): the room hasn't seen it yet. */
  forget(): void {
    this.reset();
    this.farmEpoch = null;
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
   * with (an earlier host's farm) — under the farm's epoch, or `fresh` for a
   * farm the room hasn't seen.
   */
  publishWorld(net: SharedWriter, shared: JsonObject | null, fresh: number): void {
    const world = this.view.world();
    this.farmEpoch ??= fresh;
    const patch: JsonObject = { [EPOCH_KEY]: this.farmEpoch };
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

  /** Host: a granted harvest of crop `gen` on tile `idx` — off the farm if it
   *  still grows here, and the tile published. True when the world changed. */
  harvest(net: SharedWriter, idx: number, gen: number): boolean {
    const changed = harvestTile(this.view.world(), idx, gen);
    this.publishTiles(net, [idx]);
    return changed;
  }

  /** Host: a granted clear of object `id` — gone from the farm, published.
   *  Returns the object when it was still standing here. */
  clear(net: SharedWriter, id: number): WorldObject | null {
    if (!this.clearable().some((o) => o.id === id)) {
      return null;
    }
    const world = this.view.world();
    const o = world.objects.find((c) => c.id === id);
    if (o) {
      world.removeObject(o);
    }
    publishCleared(net, id);
    return o ?? null;
  }

  // ---- guest -----------------------------------------------------------------

  /** This farmer just changed tile `idx` and told the host. */
  protectTile(idx: number, now: number): void {
    this.pendingTiles.set(idx, {
      until: now + PENDING_EDIT_MS,
      value: tileValue(this.view.world(), idx),
    });
  }

  /** This farmer just cleared object `id` and claimed it. */
  protectClear(id: number, now: number): void {
    this.pendingClears.set(id, now + PENDING_EDIT_MS);
  }

  /** This farmer's change to tile `idx` was refused: take the host's state
   *  for it now, rather than shielding the change until it lapses. */
  settleTile(idx: number, shared: JsonObject | null, now: number): void {
    this.pendingTiles.delete(idx);
    if (this.farmEpoch !== null) {
      this.applyTile(idx, hostTile(shared, idx), now);
    }
  }

  /** Fold the host's shared state into the local world. Call when it changes. */
  adopt(shared: JsonObject, now: number): void {
    const epoch = roomEpoch(shared);
    if (epoch !== null && (epoch !== this.farmEpoch || this.adoptWholeNext)) {
      this.farmEpoch = epoch;
      this.adoptWholeNext = false;
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
      if (this.farmEpoch !== null) {
        this.applyTile(idx, hostTile(shared, idx), now);
      }
    }
    for (const [id, until] of this.pendingClears) {
      if (now < until) {
        continue;
      }
      this.pendingClears.delete(id);
      if (this.farmEpoch !== null) {
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
