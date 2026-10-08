// A guest's copy of the host's world. Two worlds are kept from one stream:
//
// - the replica: every tick applied the moment it arrives — the host's world
//   as of its newest step, exact but for 0.1 px rounding. Prediction reads it
//   (freshest statuses, targets) and a promoted guest resumes from it.
// - the view (the scene's world): the same ticks replayed INTERP_DELAY_MS
//   behind the host's clock, with every remote body placed by interpolating
//   its stamped positions. Hits, deaths, projectiles landing and the bodies
//   they concern all play on that one timeline, so a spark never fires before
//   the arrow arrives; the local hero alone is drawn ahead, predicted.

import { Interpolator, RemoteClock, lerp } from "@vibedgames/multiplayer";

import { SIM_DT } from "../data/config";
import type { Vec2 } from "../sim/math";
import type { World } from "../sim/types";
import { applySnapshot, emptyGuestWorld } from "./snapshot";
import type { Snapshot, Tick } from "./snapshot";
import { applyTick } from "./stream";

/** How far behind the host's clock remote bodies are drawn (ms). Ticks come
 *  every 33 ms; this keeps two late ones in hand before the buffer runs dry. */
export const INTERP_DELAY_MS = 100;

const STEP_MS = SIM_DT * 1000;

interface Pending {
  t: number;
  tick: Tick | null;
  keyframe: Snapshot | null;
}

const lerpPose = (a: Vec2, b: Vec2, k: number): Vec2 => ({
  x: lerp(a.x, b.x, k),
  y: lerp(a.y, b.y, k),
});

const holds = (w: World, id: string): boolean => w.units.has(id) || w.projectiles.has(id);

/** Zones that ride their owner sit on the owner as drawn, not where the host
 *  last had it — call after the local hero's predicted pose is written. */
export const placeFollowers = (view: World): void => {
  for (const g of view.groundEffects) {
    const owner = g.followOwner ? view.units.get(g.ownerId) : undefined;
    if (owner) {
      g.x = owner.x;
      g.y = owner.y;
    }
  }
};

export class GuestMirror {
  /** The host's clock, shared by every body it reports. */
  readonly clock = new RemoteClock();
  /** Local time (performance.now) the newest host tick arrived; 0 before any. */
  lastTickAt = 0;
  private readonly view: World;
  private readonly bodies = new Map<string, Interpolator<Vec2>>();
  private readonly pending: Pending[] = [];
  private replica: World | null = null;
  private replicaWhole = false;
  private shownT = Number.NEGATIVE_INFINITY;
  private shownN = 0;
  private shownG = 0;
  private viewNow = 0;

  constructor(view: World) {
    this.view = view;
  }

  /** The host's world as of its newest tick, or null before any keyframe. */
  get latest(): World | null {
    return this.replica;
  }

  /** The replica, when it is whole — a keyframe that arrived live and every
   *  tick since — so a promoted guest can carry on the host's exact match. */
  get resumable(): World | null {
    return this.replicaWhole ? this.replica : null;
  }

  /**
   * A full keyframe from shared state, stamped with the host step it was taken
   * after. `live` is false for the one found on joining, which ticks the host
   * sent earlier have already moved past. Returns true when it starts a new
   * match (the clock went back), which the caller's prediction must follow.
   */
  keyframe(snap: Snapshot, stamp: number | null, live: boolean): boolean {
    const replica = emptyGuestWorld();
    applySnapshot(replica, structuredClone(snap));
    const rematch = this.replica !== null && replica.gameTime < this.replica.gameTime - 1;
    if (rematch) {
      // Every body teleports to its spawn; interpolating from the old match
      // would sweep the whole roster across the map.
      this.bodies.clear();
    }
    this.replica = replica;
    this.replicaWhole = live;
    this.pending.push({ keyframe: snap, t: stamp ?? Number.NEGATIVE_INFINITY, tick: null });
    return rematch;
  }

  /** One host tick, the moment it arrives. */
  tick(tick: Tick, receivedAt: number): void {
    this.lastTickAt = receivedAt;
    this.clock.observe(tick.t, receivedAt);
    const { replica } = this;
    if (!replica) {
      return;
    }
    // The view replays its own copy later; the two worlds share nothing.
    this.pending.push({ keyframe: null, t: tick.t, tick: structuredClone(tick) });
    applyTick(replica, tick, false);
    // Every body is sampled every step, idle ones too: an entity that stops
    // must say so, or interpolation would carry it on past where it stood.
    for (const u of replica.units.values()) {
      if (u.kind !== "structure") {
        this.body(u.id).push(tick.t, { x: u.x, y: u.y }, receivedAt);
      }
    }
    for (const p of replica.projectiles.values()) {
      this.body(p.id).push(tick.t, { x: p.x, y: p.y }, receivedAt);
    }
  }

  /**
   * Bring the view up to render time: replay the ticks it has reached, then
   * place every remote body (all but `ownId`, which prediction draws) where
   * it was at that moment on the host.
   */
  frame(localNow: number, ownId: string): void {
    const renderAt = this.clock.synced
      ? this.clock.now(localNow) - INTERP_DELAY_MS
      : Number.POSITIVE_INFINITY;
    const { view } = this;
    let [next] = this.pending;
    while (next && next.t <= renderAt) {
      this.pending.shift();
      this.show(next);
      [next] = this.pending;
    }
    if (Number.isFinite(renderAt) && Number.isFinite(this.shownT) && view.phase === "playing") {
      // Cooldowns and swing poses read world.now: advance it with render time
      // between ticks, but never past the next step, so a stalled host
      // freezes the clock instead of running it on.
      const ahead = Math.min(Math.max(renderAt - this.shownT, 0), STEP_MS);
      this.viewNow = Math.max(this.viewNow, this.shownN + ahead);
      view.now = this.viewNow;
      view.gameTime = this.shownG + (this.viewNow - this.shownN) / 1000;
    }
    for (const u of view.units.values()) {
      if (u.kind !== "structure" && u.id !== ownId) {
        this.place(u, localNow);
      }
    }
    for (const p of view.projectiles.values()) {
      this.place(p, localNow);
    }
    for (const id of this.bodies.keys()) {
      if (!holds(view, id) && !(this.replica && holds(this.replica, id))) {
        this.bodies.delete(id);
      }
    }
  }

  /** Forget the stream — the host changed (a new clock, a new baseline) or
   *  the connection dropped. Ticks are ignored until the next keyframe. */
  reset(): void {
    this.clock.reset();
    this.bodies.clear();
    this.pending.length = 0;
    this.replica = null;
    this.replicaWhole = false;
    this.shownT = Number.NEGATIVE_INFINITY;
    this.lastTickAt = 0;
  }

  private show(item: Pending): void {
    const { view } = this;
    if (item.keyframe) {
      applySnapshot(view, structuredClone(item.keyframe));
      this.shownN = view.now;
      this.shownG = view.gameTime;
      this.viewNow = view.now;
    }
    if (item.tick) {
      applyTick(view, item.tick, true);
      this.shownN = item.tick.n;
      this.shownG = item.tick.g;
    }
    this.shownT = item.t;
  }

  private body(id: string): Interpolator<Vec2> {
    let body = this.bodies.get(id);
    if (!body) {
      body = new Interpolator<Vec2>({
        clock: this.clock,
        delayMs: INTERP_DELAY_MS,
        lerp: lerpPose,
      });
      this.bodies.set(id, body);
    }
    return body;
  }

  private place(at: Vec2 & { id: string }, localNow: number): void {
    const pose = this.bodies.get(at.id)?.sample(localNow);
    if (pose) {
      at.x = pose.x;
      at.y = pose.y;
    }
  }
}
