import { Interpolator, RemoteClock, lerp } from "@vibedgames/multiplayer";

import { SIM_DT } from "../data/config";
import { dist2 } from "../sim/math";
import type { Vec2 } from "../sim/math";
import type { Projectile, World } from "../sim/types";
import { applySnapshot, emptyGuestWorld } from "./snapshot";
import type { Snapshot, Tick } from "./snapshot";
import { applyTick } from "./stream";

/** The least time behind the newest tick the stream can deliver that the view
 *  is drawn (ms). Ticks come every 33 ms; this keeps two late ones in hand
 *  before the buffer runs dry. A route whose ticks land later still draws
 *  further back: the clock measures what the stream needs (`hold()`). */
export const INTERP_DELAY_MS = 100;

const STEP_MS = SIM_DT * 1000;

interface Pending {
  t: number;
  tick: Tick | null;
  keyframe: Snapshot | null;
}

const lerpPose = (a: Vec2, b: Vec2, k: number) => ({
  x: lerp(a.x, b.x, k),
  y: lerp(a.y, b.y, k),
});

const holds = (w: World, id: string) => w.units.has(id) || w.projectiles.has(id);

const LANDING_REACH_PX = 20;

const flightEnd = (p: Projectile) => {
  const reach = p.speed * SIM_DT + LANDING_REACH_PX;
  const landed = dist2(p, { x: p.tx, y: p.ty }) <= reach * reach;

  return landed ? { x: p.tx, y: p.ty } : { x: p.x, y: p.y };
};

const fallOf = (tick: Tick, id: string) => {
  for (const fx of tick.f ?? []) {
    if (fx.t === "death" && fx.unitId === id) {
      return { x: fx.x, y: fx.y };
    }
  }

  return null;
};

/** Zones that ride their owner sit on the owner as drawn, not where the host
 *  last had it — call after the local hero's predicted pose is written. */
export const placeFollowers = (view: World) => {
  for (const g of view.groundEffects) {
    const owner = g.followOwner ? view.units.get(g.ownerId) : undefined;

    if (owner) {
      g.x = owner.x;
      g.y = owner.y;
    }
  }
};

export class GuestMirror {
  /** Local time (performance.now) the newest host tick arrived; 0 before any. */
  lastTickAt = 0;
  private readonly clock = new RemoteClock();
  private readonly view: World;
  private readonly bodies = new Map<string, Interpolator<Vec2>>();
  private readonly pending: Pending[] = [];
  private replica: World | null = null;
  private based = false;
  private replicaWhole = false;
  private shownT = Number.NEGATIVE_INFINITY;
  private shownN = 0;
  private shownG = 0;
  private viewNow = 0;

  constructor(view: World) {
    this.view = view;
  }

  /** The host's world as of its newest tick, or null before any keyframe
   *  (and between hosts). */
  get latest() {
    return this.based ? this.replica : null;
  }

  /** The replica, when it is whole — a keyframe that arrived live and every
   *  tick since — so a promoted guest can carry on the host's exact match. */
  get resumable() {
    return this.based && this.replicaWhole ? this.replica : null;
  }

  /**
   * A full keyframe from shared state, stamped (server time) with the host
   * step it was taken after. `live` is false for the one found on joining,
   * which ticks the host sent earlier have already moved past. Returns true
   * when it starts a new match (the clock went back), which the caller's
   * prediction must follow.
   */
  keyframe(snap: Snapshot, stamp: number, live: boolean) {
    const replica = emptyGuestWorld();
    applySnapshot(replica, structuredClone(snap));
    const rematch = this.replica !== null && replica.gameTime < this.replica.gameTime - 1;

    if (rematch) {
      this.bodies.clear();
    }

    this.replica = replica;
    this.based = true;
    this.replicaWhole = live;
    this.pending.push({ keyframe: snap, t: stamp, tick: null });

    return rematch;
  }

  /** One host tick, the moment it arrives (`receivedAt`, local time). */
  tick(tick: Tick, receivedAt: number) {
    this.lastTickAt = receivedAt;
    this.clock.observe(tick.t, receivedAt);
    const { replica } = this;

    if (!replica || !this.based) {
      return;
    }

    this.pending.push({ keyframe: null, t: tick.t, tick: structuredClone(tick) });
    const goneUnits = (tick.ux ?? []).flatMap((id) => replica.units.get(id) ?? []);
    const goneShots = (tick.px ?? []).flatMap((id) => replica.projectiles.get(id) ?? []);
    applyTick(replica, tick, false);

    for (const u of replica.units.values()) {
      if (u.kind !== "structure") {
        this.body(u.id).push(tick.t, { x: u.x, y: u.y }, receivedAt);
      }
    }

    for (const p of replica.projectiles.values()) {
      this.body(p.id).push(tick.t, { x: p.x, y: p.y }, receivedAt);
    }

    for (const u of goneUnits) {
      this.bodies.get(u.id)?.push(tick.t, fallOf(tick, u.id) ?? { x: u.x, y: u.y }, receivedAt);
    }

    for (const p of goneShots) {
      this.bodies.get(p.id)?.push(tick.t, flightEnd(p), receivedAt);
    }
  }

  /**
   * Bring the view up to render time: replay the ticks it has reached, then
   * place every remote body (all but `ownId`, which prediction draws) where
   * it was at that moment on the host. Until the first tick lands there is
   * nothing to time the stream by, and a keyframe shows as it lands.
   */
  frame(localNow: number, ownId: string) {
    const { clock, view } = this;

    const renderAt = clock.synced
      ? clock.now(localNow) - Math.max(INTERP_DELAY_MS, clock.hold(localNow, INTERP_DELAY_MS))
      : Number.POSITIVE_INFINITY;

    let [next] = this.pending;

    while (next && next.t <= renderAt) {
      this.pending.shift();
      this.show(next);
      [next] = this.pending;
    }

    if (!Number.isFinite(renderAt)) {
      return;
    }

    if (Number.isFinite(this.shownT) && view.phase === "playing") {
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

  /**
   * The host changed. Its ticks are deltas against its own opening keyframe,
   * so the replica rests until that arrives (prediction holds still meanwhile,
   * as the world does between hosts). The view's queue and every body's
   * history are stamped on the room's clock: they play on. The new host's
   * ticks reach us by another route, which the clock measures afresh and
   * eases onto; timed by the old route's faster trips, they would be drawn
   * early for seconds.
   */
  hostChanged() {
    this.based = false;
    this.clock.relearn();
  }

  /** Forget the stream — the connection dropped, or this client took over as
   *  host. Ticks are ignored until the next keyframe. The ticks after a
   *  reconnect may come by another route (a phone off wifi), so the clock
   *  measures it afresh, as for a new host, keeping its offset to ease from. */
  reset() {
    this.bodies.clear();
    this.pending.length = 0;
    this.replica = null;
    this.based = false;
    this.replicaWhole = false;
    this.shownT = Number.NEGATIVE_INFINITY;
    this.lastTickAt = 0;
    this.clock.relearn();
  }

  private show(item: Pending) {
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

  private body(id: string) {
    let body = this.bodies.get(id);

    if (!body) {
      body = new Interpolator<Vec2>({
        clock: this.clock,
        delayMs: INTERP_DELAY_MS,
        lerp: lerpPose,
        maxExtrapolateMs: STEP_MS,
      });
      this.bodies.set(id, body);
    }

    return body;
  }

  private place(at: Vec2 & { id: string }, localNow: number) {
    const pose = this.bodies.get(at.id)?.sample(localNow);

    if (pose) {
      at.x = pose.x;
      at.y = pose.y;
    }
  }
}
