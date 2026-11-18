// Orbs, item boxes and the four items, for every kart this client simulates
// (the local kart, and the bots while it hosts).
//
// Who decides what: a kart's owner decides what it picked up and when it uses
// an item, then tells the room. Everyone applies the same effect to the road
// (paint, a blot, a bomb in the air), and each owner decides for its own karts
// whether that effect caught them.

import type { JsonValue, MultiplayerClient } from "@vibedgames/multiplayer";

import { sfx } from "../audio/sfx";
import { isJsonNumber, isJsonObject } from "../net/wire";
import type { Sparks } from "../render/fx";
import { PickupView } from "../render/pickup-view";
import type { Bomb } from "../render/pickup-view";
import {
  BOMB_BLAST,
  BOMB_FLIGHT,
  BOMB_REACH,
  BOMB_SPLAT,
  ITEM_KINDS,
  ORB_MAX,
  SOLVENT_RADIUS,
  SOLVENT_SECONDS,
  TURBO_SECONDS,
} from "../shared/constants";
import type { ItemKind } from "../shared/constants";
import { spinOut } from "../sim/kart";
import type { Kart } from "../sim/kart";
import type { PaintGrid } from "../sim/paint";
import { Field, rollItem } from "../sim/pickups";
import type { Toucher } from "../sim/pickups";
import { pointAt } from "../sim/track";
import type { Track } from "../sim/track";
import { RAMP } from "../splat/palette";
import type { SplatSet } from "../splat/splat-set";

export const ITEM_EVENT = "item";

/** What the item system needs from the scene. */
export interface ItemHost {
  readonly client: MultiplayerClient;
  readonly paint: PaintGrid;
  readonly sparks: Sparks;
  /** The kart behind a racer key, if this client simulates it. */
  kartOf: (key: string) => Kart | null;
  slotOf: (key: string) => number;
  /** The palette ramp a racer is drawn in. */
  rampOf: (key: string) => number;
  /** 0 for the leader … 1 for last place. */
  shareOf: (key: string) => number;
  /** Something happened to the local kart worth showing. */
  notify: (what: "orb" | "box" | "spin" | "used", kind?: ItemKind) => void;
}

interface Held {
  kind: ItemKind;
  /** Scene clock at which a bot plays it; the local driver presses a key. */
  useAt: number;
}

const isItemKind = (value: JsonValue | undefined): value is ItemKind =>
  ITEM_KINDS.some((kind) => kind === value);

export class ItemSystem {
  private readonly host: ItemHost;
  private field: Field;
  private readonly view = new PickupView();
  private track: Track;
  private bombs: Bomb[] = [];
  private readonly held = new Map<string, Held>();
  private time = 0;
  private wasHere: boolean[] = [];
  private nextId = Math.floor(Math.random() * 1e9);

  constructor(host: ItemHost, track: Track) {
    this.host = host;
    this.track = track;
    this.field = new Field(track);
  }

  /** Put the pickups on stage for this frame. */
  draw(out: SplatSet, cx: number, cz: number, reach: number): void {
    this.view.draw(out, cx, cz, reach);
  }

  /** New round or new circuit: a fresh field, empty hands. */
  reset(track: Track): void {
    this.track = track;
    this.field = new Field(track);
    this.wasHere = [];
    this.bombs = [];
    this.held.clear();
  }

  /** A puff where any kart, anyone's, just took an orb or a crate. */
  private popTaken(): void {
    const { sparks } = this.host;
    const spots = [...this.field.orbs, ...this.field.boxes];
    for (const [i, spot] of spots.entries()) {
      const here = this.time >= spot.until;
      if (this.wasHere[i] === true && !here) {
        const crate = i >= this.field.orbs.length;
        sparks.burst(spot.x, 1.4, spot.z, crate ? RAMP.white : RAMP.yellow, crate ? 16 : 7, 7);
        if (crate) {
          sparks.ring(spot.x, spot.z, RAMP.yellow, 8, 14);
        }
      }
      this.wasHere[i] = here;
    }
  }

  heldBy(key: string): ItemKind | null {
    return this.held.get(key)?.kind ?? null;
  }

  /** Every frame, with every kart on the road. */
  update(time: number, karts: readonly Toucher[], racing: boolean): void {
    this.time = time;
    if (racing) {
      for (const [key, gains] of this.field.touch(karts, time)) {
        this.reward(key, gains.orbs, gains.box, gains.blot);
      }
      for (const [key, held] of this.held) {
        if (time >= held.useAt) {
          this.use(key);
        }
      }
    }
    this.land(karts);
    this.popTaken();
    this.view.update(this.field, this.bombs, time);
  }

  /** Play the item `key` holds, if it holds one. */
  use(key: string): void {
    const held = this.held.get(key);
    const kart = this.host.kartOf(key);
    if (!held || !kart) {
      return;
    }
    this.held.delete(key);
    const by = key === "me" ? (this.host.client.playerId ?? "me") : key;
    const fx = Math.cos(kart.a);
    const fz = Math.sin(kart.a);
    const target = pointAt(this.track, kart.idx + BOMB_REACH, kart.lat * 0.5);
    this.nextId += 1;
    const payload = {
      by,
      id: this.nextId,
      k: held.kind,
      tx: Math.round(target.x * 10) / 10,
      tz: Math.round(target.z * 10) / 10,
      x: Math.round((kart.x - (held.kind === "blot" ? fx * 3.2 : 0)) * 10) / 10,
      z: Math.round((kart.z - (held.kind === "blot" ? fz * 3.2 : 0)) * 10) / 10,
    };
    if (held.kind === "turbo") {
      kart.boost = Math.max(kart.boost, TURBO_SECONDS);
    } else if (held.kind === "solvent") {
      kart.proof = SOLVENT_SECONDS;
    }
    this.apply(key, payload.k, payload.x, payload.z, payload.tx, payload.tz, payload.id);
    this.host.client.sendEvent(ITEM_EVENT, payload, { except: this.host.client.playerId ?? "" });
    if (key === "me") {
      this.host.notify("used", held.kind);
    }
  }

  /** An item someone else's kart played. */
  onEvent(payload: JsonValue, from: string): void {
    if (!isJsonObject(payload)) {
      return;
    }
    const { by, id, k, tx, tz, x, z } = payload;
    if (!isItemKind(k) || !isJsonNumber(x) || !isJsonNumber(z)) {
      return;
    }
    // A bot's key travels as it is; a human's is their player id, which is `from`.
    const key = by === from || !String(by).startsWith("b") ? from : String(by);
    this.apply(
      key,
      k,
      x,
      z,
      isJsonNumber(tx) ? tx : x,
      isJsonNumber(tz) ? tz : z,
      isJsonNumber(id) ? id : 0,
    );
  }

  /** The effect on the road, the same on every client. */
  private apply(
    key: string,
    kind: ItemKind,
    x: number,
    z: number,
    tx: number,
    tz: number,
    id: number,
  ): void {
    const { paint, sparks } = this.host;
    const ramp = this.host.rampOf(key);
    if (kind === "solvent") {
      paint.wipe(x, z, SOLVENT_RADIUS, this.host.slotOf(key));
      paint.stamp(x, z, 4.5, this.host.slotOf(key));
      sparks.burst(x, 0.8, z, ramp, 46, 20);
    } else if (kind === "bomb") {
      this.bombs.push({ by: key, fromX: x, fromZ: z, ramp, t0: this.time, toX: tx, toZ: tz });
    } else if (kind === "blot") {
      this.field.dropBlot(id, key, x, z, this.time);
    } else {
      sparks.burst(x, 0.6, z, ramp, 18, 10);
    }
  }

  /** Bombs that have come down: splat the road, spin whoever was under it. */
  private land(karts: readonly Toucher[]): void {
    const flying: Bomb[] = [];
    for (const bomb of this.bombs) {
      if (this.time - bomb.t0 < BOMB_FLIGHT) {
        flying.push(bomb);
      } else {
        this.host.paint.stamp(bomb.toX, bomb.toZ, BOMB_SPLAT, this.host.slotOf(bomb.by));
        this.host.sparks.burst(bomb.toX, 0.6, bomb.toZ, bomb.ramp, 60, 18);
        this.host.sparks.ring(bomb.toX, bomb.toZ, bomb.ramp, 20, 36);
        for (const kart of karts) {
          const hit = Math.hypot(kart.x - bomb.toX, kart.z - bomb.toZ) < BOMB_BLAST;
          if (hit && kart.key !== bomb.by) {
            this.spin(kart.key);
          }
        }
        const me = this.host.kartOf("me");
        if (me && Math.hypot(bomb.toX - me.x, bomb.toZ - me.z) < 70) {
          sfx.splat();
        }
      }
    }
    this.bombs = flying;
  }

  private reward(key: string, orbs: number, box: boolean, blot: boolean): void {
    const kart = this.host.kartOf(key);
    if (!kart) {
      return;
    }
    if (orbs > 0 && kart.orbs < ORB_MAX) {
      kart.orbs = Math.min(ORB_MAX, kart.orbs + orbs);
      if (key === "me") {
        this.host.notify("orb");
      }
    }
    if (box && !this.held.has(key)) {
      const kind = rollItem(this.host.shareOf(key), Math.random());
      // A bot sits on an item for a moment, like a person would.
      const useAt = key === "me" ? Number.POSITIVE_INFINITY : this.time + 1.2 + Math.random() * 3.5;
      this.held.set(key, { kind, useAt });
      if (key === "me") {
        this.host.notify("box", kind);
      }
    }
    if (blot) {
      this.spin(key);
    }
  }

  private spin(key: string): void {
    const kart = this.host.kartOf(key);
    if (kart && kart.spin <= 0 && kart.finishMs === 0) {
      spinOut(kart);
      if (key === "me") {
        this.host.notify("spin");
      }
    }
  }
}
